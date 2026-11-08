import type { Room } from "@crosstalk/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, noHorizontalOverflow } from "./fixtures";

// Bookmarks (BookmarkButton.tsx, BookmarksPage.tsx, hub/src/bookmarks.ts): a message is bookmarked from under it, listed
// on the Bookmarks screen (its link is above Terminal in the sidebar), opened in its chat from there, and taken out.
// Phone widths, where the screen and its cards must fit. No agent runs: the chat's folder is gone before its message, so
// its reply only says so.

const HUB = "http://127.0.0.1:8451";
// CT_SHOTS: a folder to save the screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: join(process.env.CT_SHOTS, name) } : {});
const project = () => test.info().project.name;
const onPhones = () => test.skip(!/-(320|390)$/.test(project()), "Phone widths: the 320 and 390 projects.");

test("a message bookmarked in its chat is on the Bookmarks screen, opens its chat there, and can be taken out", async ({ page, request, token }) => {
  onPhones();
  const width = page.viewportSize()!.width;
  await page.setViewportSize({ width, height: 844 });
  const headers = { authorization: `Bearer ${token}` };
  const tag = Math.random().toString(36).slice(2, 6);
  const folder = mkdtempSync(join(tmpdir(), "ct-bookmarks-"));
  const room: Room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "codex", name: `Keepers ${tag}`, cwd: folder } })).json();
  try {
    rmSync(folder, { recursive: true, force: true });
    const words = `Remember the staging password rotates on Fridays ${tag}`;
    expect((await request.post(`${HUB}/api/rooms/${room.id}/messages`, { headers, data: { text: words } })).ok()).toBe(true);

    await page.goto(`/#/room/${room.id}`);
    const mine = page.locator(".your-msg").filter({ hasText: words });
    await mine.locator(".bubble, .body").first().click();
    const bookmark = mine.getByRole("button", { name: "Bookmark", exact: true });
    await expect(bookmark).toHaveAttribute("aria-pressed", "false");
    const saved = page.waitForResponse((r) => r.url().endsWith("/bookmark") && r.request().method() === "PUT");
    await bookmark.click();
    expect((await saved).ok()).toBe(true);
    await expect(mine.getByRole("button", { name: "Bookmarked", exact: true })).toHaveAttribute("aria-pressed", "true");

    // In the sidebar, Bookmarks is just above Terminal.
    const show = page.getByRole("button", { name: "Show chats", exact: true });
    if (await show.count()) await show.click();
    const side = page.getByRole("complementary", { name: "Chats", exact: true });
    const link = side.getByRole("button", { name: "Bookmarks", exact: true });
    const terminal = side.getByRole("button", { name: "Terminal", exact: true });
    await expect(link).toBeVisible();
    const [a, b] = [await link.boundingBox(), await terminal.boundingBox()];
    expect(a!.y + a!.height).toBeLessThanOrEqual(b!.y + 1);
    await page.screenshot({ ...shot(`bookmarks-sidebar-${width}.png`), animations: "disabled" });
    await link.click();

    await expect(page.getByRole("heading", { name: "Bookmarks", exact: true })).toBeVisible();
    const list = page.getByRole("list", { name: "Bookmarks", exact: true });
    const card = list.getByRole("listitem").filter({ hasText: words });
    await expect(card).toBeVisible();
    await expect(card).toContainText(`Keepers ${tag}`);
    await expect(card).toContainText("You");
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot(`bookmarks-${width}.png`), animations: "disabled" });

    // Open in chat: the chat, at the message.
    await card.getByRole("button", { name: "Open in chat", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`#/room/${room.id}$`));
    await expect(page.locator(".your-msg").filter({ hasText: words })).toBeInViewport();

    // Taken out from the Bookmarks screen: gone there, and not bookmarked in the chat either.
    await page.goto("/#/bookmarks");
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(card).toHaveCount(0);
    const left = ((await (await request.get(`${HUB}/api/bookmarks`, { headers })).json()) as { bookmarks: { messageId: string }[] }).bookmarks;
    expect(left.length).toBe(0);
    await expect(page.getByText("No bookmarks yet", { exact: true })).toBeVisible();
  } finally {
    await request.delete(`${HUB}/api/rooms/${room.id}`, { headers });
    rmSync(folder, { recursive: true, force: true });
  }
});
