import type { APIRequestContext, Locator, Page } from "@playwright/test";
import type { Member, Room } from "@crosstalk/shared";
import { join } from "node:path";
import { test, expect, noHorizontalOverflow } from "./fixtures";

// Folding a section of the chat list away on a phone (web/src/views/GroupFold.tsx): Pinned, Working and Recent fold,
// each from its own button at the end of its heading; a folded section says when something inside needs a look, and
// this device remembers it. Needs you never folds (web/e2e/chatListState.spec.ts). The wording, what's kept and the markup are in
// web/src/chatList.test.ts, src/sidebar.test.ts and src/groupFold.test.tsx.

const HUB = "http://127.0.0.1:8451";
// CT_SHOTS: a folder to save the phone screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: join(process.env.CT_SHOTS, name) } : {});
const FOLDED_KEY = "crosstalk.sidebar.folded";
/** Once per browser, at a phone's width: that's where the control has to be a finger's size. */
const onPhone = () => test.skip(!/-390$/.test(test.info().project.name), "Once per browser, at 390.");

/** Chats with Codex, made in this order. */
async function made(request: APIRequestContext, token: string, names: string[]) {
  const headers = { authorization: `Bearer ${token}` };
  const rooms: Room[] = [];
  for (const name of names) rooms.push(await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "codex", name } })).json());
  return {
    rooms,
    pin: (room: Room) => request.post(`${HUB}/api/rooms/${room.id}/pin`, { headers, data: { pinned: true, order: -1 } }),
    cleanup: async () => {
      for (const r of rooms) await request.delete(`${HUB}/api/rooms/${r.id}`, { headers });
    },
  };
}

/**
 * The list holds these chats and no others (whatever else the shared test hub has), in the order given, each a second
 * apart. `unread`: that chat has a reply you haven't read; `error`: that chat's agent stopped with an error (both are
 * chats that need a look); `working`: that chat's agent is at work.
 */
async function onlyThese(page: Page, ids: string[], also: { unread?: string; error?: string; working?: string } = {}) {
  const place = new Map(ids.map((id, i) => [id, i]));
  await page.route("**/api/state", async (route) => {
    const s = await (await route.fetch()).json();
    s.rooms = (s.rooms as Room[])
      .filter((r) => place.has(r.id))
      .map((r) => ({ ...r, updatedAt: Date.now() - (place.size - place.get(r.id)!) * 1000, ...(r.id === also.unread ? { lastReplyAt: Date.now(), readAt: Date.now() - 60_000 } : {}) }));
    s.members = (s.members as Member[]).filter((m) => place.has(m.roomId)).map((m) => (m.roomId === also.error ? { ...m, status: "error" } : m.roomId === also.working ? { ...m, status: "working" } : m));
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

/** One section of the list, by its heading: Pinned, Needs you, Working, Recent. */
const sectionOf = (side: Locator, name: string) => side.getByRole("region", { name, exact: true });
/** A chat's row and its ⋯, wherever it is in the list. */
const rowOf = (where: Locator, name: string) => where.locator(".csb-item").filter({ has: where.page().locator(".csb-chat-name", { hasText: new RegExp(`^${name}$`) }) });
const moreOf = (where: Locator, name: string) => rowOf(where, name).getByRole("button", { name: `Options for ${name}`, exact: true });
const kept = (page: Page) => page.evaluate((key) => localStorage.getItem(key), FOLDED_KEY).then((v) => JSON.parse(v ?? "null"));

test("Pinned, Working and Recent fold away, say what's inside, and are still folded after a reload", async ({ page, request, token }) => {
  onPhone();
  await page.setViewportSize({ width: 390, height: 844 });
  const mine = await made(request, token, ["Old one", "Write docs", "Fix login", "Run tests", "Ship it"]);
  const [old, , fix, tests] = mine.rooms;
  try {
    // One pinned, one at work, three under Recent — the oldest of them with a reply nobody has read: folded, Recent
    // must still say someone is wanted.
    await onlyThese(page, mine.rooms.map((r) => r.id), { unread: old.id, working: tests.id });
    await mine.pin(fix);
    await page.goto("/");
    const side = await drawer(page);
    const pinned = sectionOf(side, "Pinned");
    const working = sectionOf(side, "Working");
    const recent = sectionOf(side, "Recent");
    await expect(pinned.locator(".csb-chat")).toHaveCount(1);
    await expect(working.locator(".csb-chat")).toHaveCount(1);
    await expect(recent.locator(".csb-chat")).toHaveCount(3);
    // Open, the control only says what it folds — and it's a finger's size.
    const fold = recent.getByRole("button", { name: "Hide recent chats", exact: true });
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    const box = (await fold.boundingBox())!;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
    await fold.click();

    // Folded: no rows; the control says how many chats are inside, and the line under the heading that one needs a look.
    await expect(recent.locator(".csb-chat")).toHaveCount(0);
    const folded = recent.getByRole("button", { name: "Show recent chats, 3 chats, 1 needs a look", exact: true });
    await expect(folded).toHaveAttribute("aria-expanded", "false");
    await expect(recent.locator(".csb-fold-said")).toHaveText("1 needs a look");
    // The heading keeps its own count either way.
    await expect(recent.locator(".csb-heading")).toHaveText("Recent 3");
    // A reply nobody has read is not an agent waiting for you: the mark is there, without the needs-you orange.
    await expect(recent.locator(".csb-fold-mark")).toBeVisible();
    await expect(recent.locator(".csb-fold-mark")).not.toHaveClass(/needs|error/);
    // Its rows hang off the control: aria-controls names the box they live in, which is there while it's folded too.
    const names = await folded.getAttribute("aria-controls");
    await expect(recent.locator(".csb-group-rows")).toHaveAttribute("id", names!);
    // Pinned folds the same way; nothing of its needs a look, so it's its heading (with its count) alone.
    await pinned.getByRole("button", { name: "Hide pinned chats", exact: true }).click();
    await expect(pinned.locator(".csb-chat")).toHaveCount(0);
    await expect(pinned.getByRole("button", { name: "Show pinned chats, 1 chat", exact: true })).toBeVisible();
    await expect(pinned.locator(".csb-heading")).toHaveText("Pinned 1");
    await expect(pinned.locator(".csb-fold-said, .csb-fold-mark")).toHaveCount(0);
    // Working too: how many, and no more — a chat at work isn't one that needs a look.
    await working.getByRole("button", { name: "Hide working chats", exact: true }).click();
    await expect(working.locator(".csb-chat")).toHaveCount(0);
    await expect(working.getByRole("button", { name: "Show working chats, 1 chat", exact: true })).toBeVisible();
    await expect(working.locator(".csb-fold-said, .csb-fold-mark")).toHaveCount(0);
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("chat-list-folded-390.png"), animations: "disabled" });

    // Reloaded, all three are still folded, and only the folded ones are kept on this device.
    await page.reload();
    const after = await drawer(page);
    await expect(sectionOf(after, "Recent").getByRole("button", { name: "Show recent chats, 3 chats, 1 needs a look", exact: true })).toBeVisible();
    await expect(after.locator(".csb-chat")).toHaveCount(0);
    expect(await kept(page)).toEqual({ recent: true, pinned: true, working: true });
    // Unfolded again: its chats are back, and that's remembered as well (not kept as a false).
    await sectionOf(after, "Recent").getByRole("button", { name: /^Show recent chats/ }).click();
    await expect(sectionOf(after, "Recent").locator(".csb-chat-name")).toHaveText(["Ship it", "Write docs", "Old one"]);
    await page.reload();
    const back = await drawer(page);
    await expect(sectionOf(back, "Recent").locator(".csb-chat")).toHaveCount(3);
    await expect(sectionOf(back, "Pinned").locator(".csb-chat")).toHaveCount(0);
    await expect(sectionOf(back, "Working").locator(".csb-chat")).toHaveCount(0);
    expect(await kept(page)).toEqual({ pinned: true, working: true });
  } finally {
    await mine.cleanup();
  }
});

test("the fold control works from the keyboard, and a search shows what's inside anyway", async ({ page, request, token }) => {
  onPhone();
  await page.setViewportSize({ width: 390, height: 844 });
  const mine = await made(request, token, ["Fix login", "Write docs"]);
  try {
    await onlyThese(page, mine.rooms.map((r) => r.id));
    await page.goto("/");
    const side = await drawer(page);
    const recent = sectionOf(side, "Recent");
    const fold = recent.locator(".csb-fold");
    await expect(recent.locator(".csb-chat")).toHaveCount(2);
    // The heading is words, not a button: the fold control is the one thing in it the keyboard stops at.
    await expect(recent.locator(".csb-group-head").getByRole("button")).toHaveCount(1);
    await expect(recent.getByRole("heading", { name: "Recent 2" })).toBeVisible();
    await fold.focus();
    await page.keyboard.press("Enter");
    await expect(recent.locator(".csb-chat")).toHaveCount(0);
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    // Focus stays on the control, so the next press opens the section again.
    await expect(fold).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(recent.locator(".csb-chat")).toHaveCount(2);
    await expect(fold).toHaveAttribute("aria-expanded", "true");

    // Folded, a search still shows its matches — folding is ignored while you're looking for something, as "Show all" is.
    await page.keyboard.press("Enter");
    await expect(recent.locator(".csb-chat")).toHaveCount(0);
    const search = side.getByRole("textbox", { name: "Search chats", exact: true });
    await search.fill("login");
    await expect(side.locator(".csb-chat-name")).toHaveText(["Fix login"]);
    await expect(side.locator(".csb-fold")).toHaveCount(0);
    // Cleared: folded again, where it was left.
    await search.fill("");
    await expect(recent.locator(".csb-chat")).toHaveCount(0);
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    expect(await kept(page)).toEqual({ recent: true });
  } finally {
    await mine.cleanup();
  }
});

test("a folded section's words never crowd its heading, at 390 or 320", async ({ page, request, token }) => {
  onPhone();
  await page.setViewportSize({ width: 390, height: 844 });
  const mine = await made(request, token, ["Fix login", "Write docs", "Old one"]);
  try {
    // A pinned chat has stopped with an error, and one under Recent has a reply nobody has read: both sections have
    // the most a folded one says.
    await onlyThese(page, mine.rooms.map((r) => r.id), { error: mine.rooms[1].id, unread: mine.rooms[2].id });
    await mine.pin(mine.rooms[1]);
    await page.goto("/");
    const side = await drawer(page);
    const sections = [sectionOf(side, "Pinned"), sectionOf(side, "Recent")];
    await expect(sections[0].locator(".csb-chat")).toHaveCount(1);
    const heads = () => Promise.all(sections.map(async (g) => (await g.locator(".csb-group-head").boundingBox())!.height));
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const open = await heads();
      for (const g of sections) await g.locator(".csb-fold").click();
      // A chat stopped with an error: the mark is the rows' red, never the orange that means "waiting for you".
      await expect(sections[0].locator(".csb-fold-mark")).toHaveClass(/error/);
      await expect(sections[0].locator(".csb-fold-said")).toHaveText("1 needs a look");
      await expect(sections[1].locator(".csb-fold-said")).toHaveText("1 needs a look");
      // Folding changed nothing about the heading rows: what's inside is said on the line below, so the section's own
      // name and count keep the row to themselves — on one line, never under the control.
      expect(await heads()).toEqual(open);
      for (const g of sections) {
        const head = (await g.locator(".csb-group-head").boundingBox())!;
        const name = (await g.locator(".csb-heading").boundingBox())!;
        const fold = (await g.locator(".csb-fold").boundingBox())!;
        const said = (await g.locator(".csb-fold-said").boundingBox())!;
        expect(name.height).toBeLessThanOrEqual(head.height);
        expect(name.x + name.width).toBeLessThanOrEqual(fold.x + 1);
        expect(said.y).toBeGreaterThanOrEqual(head.y + head.height - 1);
        // The control is still a finger's size, at the end of the row.
        expect(Math.min(fold.width, fold.height)).toBeGreaterThanOrEqual(44);
      }
      await noHorizontalOverflow(page);
      await page.screenshot({ ...shot(`chat-list-folded-head-${width}.png`), animations: "disabled" });
      // Open again, so the next width starts where this one did.
      for (const g of sections) await g.locator(".csb-fold").click();
    }
  } finally {
    await mine.cleanup();
  }
});

test("a chat unpinned into a folded section opens it, instead of dropping the row and the focus", async ({ page, request, token }) => {
  onPhone();
  await page.setViewportSize({ width: 390, height: 844 });
  const mine = await made(request, token, ["Fix login", "Write docs"]);
  try {
    await onlyThese(page, mine.rooms.map((r) => r.id));
    // Pinned on the hub, so the list opens with it at the top, out of Recent.
    await mine.pin(mine.rooms[0]);
    await page.goto("/");
    const side = await drawer(page);
    const recent = sectionOf(side, "Recent");
    const pinned = sectionOf(side, "Pinned");
    await expect(rowOf(pinned, "Fix login")).toBeVisible();
    await recent.locator(".csb-fold").click();
    await expect(recent.getByRole("button", { name: "Show recent chats, 1 chat", exact: true })).toBeVisible();

    // Unpinned from the keyboard, it drops back into Recent — which is folded away.
    await moreOf(pinned, "Fix login").focus();
    await page.keyboard.press("Enter");
    await rowOf(pinned, "Fix login").getByRole("button", { name: "Unpin", exact: true }).click();
    // The section opened rather than swallowing the row: you see where the chat went, and focus went with it to its own ⋯.
    await expect(recent.getByRole("button", { name: "Hide recent chats", exact: true })).toBeVisible();
    await expect(rowOf(recent, "Fix login")).toBeVisible();
    await expect(moreOf(recent, "Fix login")).toBeFocused();
    // Opened for good on this device, not left folded with a chat hidden behind it.
    expect(await kept(page)).toEqual({});
  } finally {
    await mine.cleanup();
  }
});
