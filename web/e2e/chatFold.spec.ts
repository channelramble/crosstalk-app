import type { APIRequestContext, Locator, Page } from "@playwright/test";
import type { AgentAccount, Member, Room } from "@crosstalk/shared";
import { join } from "node:path";
import { test, expect, noHorizontalOverflow } from "./fixtures";

// Folding a group of the chat list away on a phone (web/src/views/GroupFold.tsx): the control is its own button beside
// the heading, so an agent's heading still opens its screen and a model's still starts a chat; a folded group says
// what's inside, and this device remembers it. The wording, what's kept and the markup are in web/src/chatList.test.ts,
// src/sidebar.test.ts and src/groupFold.test.tsx.

const HUB = "http://127.0.0.1:8451";
// CT_SHOTS: a folder to save the phone screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: join(process.env.CT_SHOTS, name) } : {});
const QWEN = "qwen3.8-9b";
const FOLDED_KEY = "crosstalk.sidebar.folded";
/** Once per browser, at a phone's width: that's where the control has to be a finger's size. */
const onPhone = () => test.skip(!/-390$/.test(test.info().project.name), "Once per browser, at 390.");

/** Chats on Codex's own sign-in, and — with `service` (its label) — a model of yours with one chat on it. */
async function made(request: APIRequestContext, token: string, names: string[], service?: string) {
  const headers = { authorization: `Bearer ${token}` };
  const account: AgentAccount | null = service
    ? await (await request.post(`${HUB}/api/accounts/endpoint`, { headers, data: { provider: "codex", label: service, baseUrl: "http://127.0.0.1:8099", apiKey: "", models: [QWEN], contextWindow: 16384 } })).json()
    : null;
  const rooms: Room[] = [];
  for (const name of names) rooms.push(await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "codex", name } })).json());
  const mine: Room | null = account ? await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "codex", account: account.id, model: QWEN, name: "On my own model" } })).json() : null;
  return {
    rooms,
    mine,
    account,
    cleanup: async () => {
      for (const r of [...rooms, ...(mine ? [mine] : [])]) await request.delete(`${HUB}/api/rooms/${r.id}`, { headers });
      if (account) await request.delete(`${HUB}/api/accounts/codex/${account.id}`, { headers });
    },
  };
}

/**
 * The list holds these chats and no others (whatever else the shared test hub has), in the order given, each a second
 * apart. `unread`: that chat has a reply you haven't read; `error`: that chat's agent stopped with an error (both are
 * chats that need a look); `usage`: Codex's plan is this far used, so its heading carries the badge it does in life.
 */
async function onlyThese(page: Page, ids: string[], also: { unread?: string; error?: string; usage?: number } = {}) {
  const place = new Map(ids.map((id, i) => [id, i]));
  await page.route("**/api/state", async (route) => {
    const s = await (await route.fetch()).json();
    s.rooms = (s.rooms as Room[])
      .filter((r) => place.has(r.id))
      .map((r) => ({ ...r, updatedAt: Date.now() - (place.size - place.get(r.id)!) * 1000, ...(r.id === also.unread ? { lastReplyAt: Date.now(), readAt: Date.now() - 60_000 } : {}) }));
    s.members = (s.members as Member[]).filter((m) => place.has(m.roomId)).map((m) => (m.roomId === also.error ? { ...m, status: "error" } : m));
    if (also.usage !== undefined) s.usage = [{ provider: "codex", accountId: "default", account: null, plan: "Plus", windows: [{ label: "Weekly", usedPercent: also.usage, resetsAt: null }], credits: null, note: null, updatedAt: Date.now() }];
    await route.fulfill({ json: s });
  });
}

/** The chats drawer on a phone, opened. */
async function drawer(page: Page) {
  await page.getByRole("button", { name: /^Show chats/ }).click();
  const side = page.getByRole("complementary", { name: "Chats", exact: true });
  await expect(side).toBeVisible();
  return side;
}

/** One group of the list, by what its heading says. */
const groupOf = (side: Locator, name: string) => side.locator(".csb-group").filter({ has: side.page().locator(".csb-agent-name", { hasText: name }) });
/** A chat's row and its ⋯, wherever it is in the list. */
const rowOf = (where: Locator, name: string) => where.locator(".csb-item").filter({ has: where.page().locator(".csb-chat-name", { hasText: new RegExp(`^${name}$`) }) });
const moreOf = (where: Locator, name: string) => rowOf(where, name).getByRole("button", { name: `Options for ${name}`, exact: true });
const kept = (page: Page) => page.evaluate((key) => localStorage.getItem(key), FOLDED_KEY).then((v) => JSON.parse(v ?? "null"));

test("an agent group and a model group fold away, say what's inside, and are still folded after a reload", async ({ page, request, token }) => {
  onPhone();
  await page.setViewportSize({ width: 390, height: 844 });
  const mine = await made(request, token, ["Fix login", "Write docs", "Old one"], "Qwen here");
  try {
    // The oldest Codex chat has a reply nobody has read: folded, the group must still say someone is wanted.
    await onlyThese(page, [...mine.rooms.map((r) => r.id), mine.mine!.id], { unread: mine.rooms[2].id });
    await page.goto("/");
    const side = await drawer(page);
    const codex = groupOf(side, "Codex");
    const qwen = groupOf(side, "Qwen here");
    await expect(codex.locator(".csb-chat")).toHaveCount(3);
    await expect(qwen.locator(".csb-chat")).toHaveCount(1);
    // Open, the control only says what it folds — and it's a finger's size.
    const fold = codex.getByRole("button", { name: "Hide Codex chats", exact: true });
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    const box = (await fold.boundingBox())!;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
    await fold.click();

    // Folded: no rows, and the heading says how many chats are inside and that one needs a look.
    await expect(codex.locator(".csb-chat")).toHaveCount(0);
    const folded = codex.getByRole("button", { name: "Show Codex chats, 3 chats, 1 needs a look", exact: true });
    await expect(folded).toHaveAttribute("aria-expanded", "false");
    await expect(codex.locator(".csb-fold-said")).toHaveText("3 chats, 1 needs a look");
    // A reply nobody has read is not an agent waiting for you: the mark is there, without the needs-you orange.
    await expect(codex.locator(".csb-fold-mark")).toBeVisible();
    await expect(codex.locator(".csb-fold-mark")).not.toHaveClass(/needs|error/);
    // Its rows hang off the control: aria-controls names the box they live in, which is there while it's folded too.
    const names = await folded.getAttribute("aria-controls");
    await expect(codex.locator(".csb-group-rows")).toHaveAttribute("id", names!);
    // A model of yours folds the same way; nothing of its needs a look, so there's no mark.
    await qwen.getByRole("button", { name: "Hide Qwen here chats", exact: true }).click();
    await expect(qwen.locator(".csb-chat")).toHaveCount(0);
    await expect(qwen.locator(".csb-fold-said")).toHaveText("1 chat");
    await expect(qwen.locator(".csb-fold-mark")).toHaveCount(0);
    // The group that has no chats folds as well — that empty "Claude Code / No chats yet." pair is the clutter
    // folding is for — and folded it is its heading alone.
    const claude = groupOf(side, "Claude Code");
    await expect(claude.locator(".csb-empty")).toHaveText("No chats yet.");
    await claude.getByRole("button", { name: "Hide Claude Code chats", exact: true }).click();
    await expect(claude.locator(".csb-empty")).toHaveCount(0);
    await expect(claude.getByRole("button", { name: "Show Claude Code chats, no chats", exact: true })).toBeVisible();
    await expect(claude.locator(".csb-fold-said")).toHaveCount(0);
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("chat-list-folded-390.png"), animations: "disabled" });

    // Folding took nothing away: the model's own heading still starts a chat on it.
    await qwen.getByRole("button", { name: "New chat with Qwen here, on this machine", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New chat with Qwen here", exact: true });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // Reloaded, both are still folded, and only the folded ones are kept on this device.
    await page.reload();
    const after = await drawer(page);
    await expect(groupOf(after, "Codex").getByRole("button", { name: "Show Codex chats, 3 chats, 1 needs a look", exact: true })).toBeVisible();
    await expect(groupOf(after, "Codex").locator(".csb-chat")).toHaveCount(0);
    await expect(groupOf(after, "Qwen here").locator(".csb-chat")).toHaveCount(0);
    expect(await kept(page)).toEqual({ codex: true, claude: true, [`svc:codex:${mine.account!.id}`]: true });
    // Unfolded again: its chats are back, and that's remembered as well (not kept as a false).
    await groupOf(after, "Codex").getByRole("button", { name: /^Show Codex chats/ }).click();
    await expect(groupOf(after, "Codex").locator(".csb-chat")).toHaveCount(3);
    await page.reload();
    const back = await drawer(page);
    await expect(groupOf(back, "Codex").locator(".csb-chat")).toHaveCount(3);
    await expect(groupOf(back, "Qwen here").locator(".csb-chat")).toHaveCount(0);
    expect(await kept(page)).toEqual({ claude: true, [`svc:codex:${mine.account!.id}`]: true });
  } finally {
    await mine.cleanup();
  }
});

test("the fold control works from the keyboard, a search shows what's inside anyway, and the heading still opens the agent", async ({ page, request, token }) => {
  onPhone();
  await page.setViewportSize({ width: 390, height: 844 });
  const mine = await made(request, token, ["Fix login", "Write docs"]);
  try {
    await onlyThese(page, mine.rooms.map((r) => r.id));
    await page.goto("/");
    const side = await drawer(page);
    const codex = groupOf(side, "Codex");
    const heading = codex.locator(".csb-agent");
    const fold = codex.locator(".csb-fold");
    await expect(codex.locator(".csb-chat")).toHaveCount(2);
    // The heading's own action and the fold are two buttons, both on the keyboard, in that order.
    await heading.focus();
    await expect(heading).toBeFocused();
    // Tab goes on to the control. Only in Chromium: WebKit tabs to buttons only with Full Keyboard Access on, as
    // Safari does, and the pins' keyboard test is held to one engine for the same reason.
    if (/^chromium/.test(test.info().project.name)) {
      await page.keyboard.press("Tab");
      await expect(fold).toBeFocused();
    }
    await fold.focus();
    await page.keyboard.press("Enter");
    await expect(codex.locator(".csb-chat")).toHaveCount(0);
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    // Focus stays on the control, so the next press opens the group again.
    await expect(fold).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(codex.locator(".csb-chat")).toHaveCount(2);
    await expect(fold).toHaveAttribute("aria-expanded", "true");

    // Folded, a search still shows its matches — folding is ignored while you're looking for something, as "Show all" is.
    await page.keyboard.press("Enter");
    await expect(codex.locator(".csb-chat")).toHaveCount(0);
    const search = side.getByRole("textbox", { name: "Search chats", exact: true });
    await search.fill("login");
    await expect(codex.locator(".csb-chat-name")).toHaveText(["Fix login"]);
    await expect(fold).toHaveCount(0);
    // Cleared: folded again, where it was left.
    await search.fill("");
    await expect(codex.locator(".csb-chat")).toHaveCount(0);
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    expect(await kept(page)).toEqual({ codex: true });

    // The heading itself still opens the agent's own screen.
    await heading.click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("#/agent/codex");
  } finally {
    await mine.cleanup();
  }
});

test("a folded group's words never crowd the group's own name, at 390 or 320", async ({ page, request, token }) => {
  onPhone();
  await page.setViewportSize({ width: 390, height: 844 });
  const mine = await made(request, token, ["Fix login", "Write docs", "Old one"], "Qwen3 Coder 30B on the server");
  try {
    // Codex's plan badge sits at the end of its heading, and a chat of its own has stopped with an error: a heading
    // with everything in it, which is where cramming what's inside beside the name used to wrap or paint over it.
    await onlyThese(page, [...mine.rooms.map((r) => r.id), mine.mine!.id], { usage: 87, error: mine.rooms[1].id });
    await page.goto("/");
    const side = await drawer(page);
    const codex = groupOf(side, "Codex");
    const qwen = groupOf(side, "Qwen3 Coder 30B on the server");
    await expect(codex.locator(".csb-usage")).toHaveText("87%");
    const groups = [codex, qwen];
    const heads = () => Promise.all(groups.map(async (g) => (await g.locator(".csb-group-head").boundingBox())!.height));
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const open = await heads();
      for (const g of groups) await g.locator(".csb-fold").click();
      // A chat stopped with an error: the mark is the rows' red, never the orange that means "waiting for you".
      await expect(codex.locator(".csb-fold-mark")).toHaveClass(/error/);
      // Folding changed nothing about the heading rows: what's inside is said on the line below, so the group's own
      // name keeps the row to itself — on one line, never under the control and never under the usage badge.
      expect(await heads()).toEqual(open);
      for (const g of groups) {
        const head = (await g.locator(".csb-group-head").boundingBox())!;
        const name = (await g.locator(".csb-agent-name").boundingBox())!;
        const fold = (await g.locator(".csb-fold").boundingBox())!;
        const said = (await g.locator(".csb-fold-said").boundingBox())!;
        expect(name.height).toBeLessThan(24);
        expect(name.x + name.width).toBeLessThanOrEqual(fold.x + 1);
        // Enough of the name is left to tell which group you folded.
        expect(name.width).toBeGreaterThan(head.width * 0.4);
        expect(said.y).toBeGreaterThanOrEqual(head.y + head.height - 1);
      }
      const name = (await codex.locator(".csb-agent-name").boundingBox())!;
      const usage = (await codex.locator(".csb-usage").boundingBox())!;
      expect(usage.x).toBeGreaterThanOrEqual(name.x + name.width - 1);
      await noHorizontalOverflow(page);
      await page.screenshot({ ...shot(`chat-list-folded-head-${width}.png`), animations: "disabled" });
      // Open again, so the next width starts where this one did.
      for (const g of groups) await g.locator(".csb-fold").click();
    }
  } finally {
    await mine.cleanup();
  }
});

test("a chat unpinned into a folded group opens it, instead of dropping the row and the focus", async ({ page, request, token }) => {
  onPhone();
  await page.setViewportSize({ width: 390, height: 844 });
  const mine = await made(request, token, ["Fix login", "Write docs"]);
  try {
    await onlyThese(page, mine.rooms.map((r) => r.id));
    // Pinned on the hub, so the list opens with it at the top, out of its agent's group.
    await request.post(`${HUB}/api/rooms/${mine.rooms[0].id}/pin`, { headers: { authorization: `Bearer ${token}` }, data: { pinned: true, order: -1 } });
    await page.goto("/");
    const side = await drawer(page);
    const codex = groupOf(side, "Codex");
    const pinned = side.getByRole("region", { name: "Pinned", exact: true });
    await expect(rowOf(pinned, "Fix login")).toBeVisible();
    await codex.locator(".csb-fold").click();
    await expect(codex.locator(".csb-fold-said")).toHaveText("1 chat");

    // Unpinned from the keyboard, it drops back into Codex's group — which is folded away.
    await moreOf(pinned, "Fix login").focus();
    await page.keyboard.press("Enter");
    await rowOf(pinned, "Fix login").getByRole("button", { name: "Unpin", exact: true }).click();
    // The group opened rather than swallowing the row: you see where the chat went, and focus went with it to its own ⋯.
    await expect(codex.getByRole("button", { name: "Hide Codex chats", exact: true })).toBeVisible();
    await expect(rowOf(codex, "Fix login")).toBeVisible();
    await expect(moreOf(codex, "Fix login")).toBeFocused();
    // Opened for good on this device, not left folded with a chat hidden behind it.
    expect(await kept(page)).toEqual({});
  } finally {
    await mine.cleanup();
  }
});
