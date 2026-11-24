import type { Page } from "@playwright/test";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { given } from "./tourChats";

/*
 * A tour of every main screen with realistic content, at the sizes people hold: phones (320 × 568, 390 × 844,
 * 430 × 932), a tablet (768 × 1024) and computers (1024 × 768, 1440 × 900, 1920 × 1080). On each screen: the app fills
 * the window, nothing is wider than it, every control showing is fully on screen, and on a touch-sized layout every
 * button is big enough for a finger. CT_SHOTS=/some/dir saves a picture of each, to look at.
 *
 * The chats are made up for the page alone (tourChats.ts).
 */

type Size = { width: number; height: number };
const SIZES: Record<string, Size[]> = {
  "chromium-320": [{ width: 320, height: 568 }],
  "chromium-390": [{ width: 390, height: 844 }],
  "chromium-430": [{ width: 430, height: 932 }],
  "chromium-768": [{ width: 768, height: 1024 }],
  "chromium-1440": [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 1920, height: 1080 }],
  "webkit-390": [{ width: 390, height: 844 }],
};

/** What doesn't fit on the screen as it is now, in words. `fingers`: buttons must be finger-sized (44 px). */
async function misfits(page: Page, size: Size, fingers: boolean): Promise<string[]> {
  await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))));
  return page.evaluate(
    ([size, fingers]) => {
      const out: string[] = [];
      const W = size.width;
      const H = size.height;
      const name = (el: Element) => `${el.tagName.toLowerCase()}${typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : ""} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40)}"`;
      if (document.documentElement.scrollWidth > W) out.push(`the page is ${document.documentElement.scrollWidth}px wide`);
      const app = document.querySelector(".app")?.getBoundingClientRect();
      if (app && (Math.abs(app.width - W) > 1.5 || Math.abs(app.height - H) > 1.5)) out.push(`the app is ${app.width} × ${app.height}`);
      const shown = (el: Element) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return false;
        if (typeof el.checkVisibility === "function" && !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
        return true;
      };
      // Under a sheet, only the sheet is in reach.
      const sheets = document.querySelectorAll(".overlay");
      // Nor, under an open menu, what the menu covers.
      const top = sheets[sheets.length - 1] ?? document.querySelector(".csb-new-menu") ?? document.querySelector(".chat-sidebar.drawer") ?? document.body;
      for (const el of top.querySelectorAll("button, input:not([type=hidden]), textarea, select, a[href], [role=dialog], .ctl-pop")) {
        if (!shown(el) || el.closest(".msg-actions:not(.shown), pre, .composer-files, [data-ghost], table, .md-table, .xterm")) continue;
        const r = el.getBoundingClientRect();
        const row = el.closest(".settings-tabs-row");
        if (row && row.scrollWidth > row.clientWidth + 1) continue;
        if (r.left < -1 || r.right > W + 1) out.push(`${name(el)} spans ${Math.round(r.left)} to ${Math.round(r.right)} across`);
        if (el.matches("[role=dialog], .ctl-pop") && (r.top < -1 || r.bottom > H + 1)) out.push(`${name(el)} spans ${Math.round(r.top)} to ${Math.round(r.bottom)} down`);
        for (let p = el.parentElement; p; p = p.parentElement) {
          if (getComputedStyle(p).overflowX !== "hidden") continue;
          const c = p.getBoundingClientRect();
          if (r.right > c.right + 1.5 || r.left < c.left - 1.5) out.push(`${name(el)} is cut off by .${String(p.className).slice(0, 40)}`);
          break;
        }
        // A finger's size: a tap lands on it anywhere in an area 44 px tall and at least 40 wide (some are drawn
        // smaller and take taps around themselves). Links in running text aside, and what's partly scrolled away.
        if (fingers && el.matches("button, select, input[type=checkbox], input[type=radio], a.btn") && !el.closest("p, li, .md, .markdown, .help")) {
          const target = el.closest("label") ?? el;
          const t = target.getBoundingClientRect();
          const hits = (x: number, y: number) => {
            const at = document.elementFromPoint(x, y);
            return !!at && (at === target || target.contains(at) || at.contains(target));
          };
          const cx = t.left + t.width / 2;
          const cy = t.top + t.height / 2;
          if (t.top < 0 || t.bottom > H || !hits(cx, cy)) continue;
          let up = cy, down = cy, left = cx, right = cx;
          while (up > 0 && cy - up < 30 && hits(cx, up - 1)) up--;
          while (down < H && down - cy < 30 && hits(cx, down + 1)) down++;
          while (left > 0 && cx - left < 30 && hits(left - 1, cy)) left--;
          while (right < W && right - cx < 30 && hits(right + 1, cy)) right++;
          const h = Math.round(down - up + 1);
          const w = Math.round(right - left + 1);
          // Cut short by the edge of what it scrolls in: not its own size.
          let cut = false;
          for (let p = el.parentElement; p && !cut; p = p.parentElement) {
            if (!/auto|scroll|hidden/.test(getComputedStyle(p).overflowY)) continue;
            const sc = p.getBoundingClientRect();
            cut = up - sc.top < 2 || sc.bottom - down < 2;
          }
          if (cut) continue;
          if (h < 43 || w < 40) out.push(`${name(el)} takes a tap ${w} × ${h}: small for a finger`);
        }
      }
      return out;
    },
    [size, fingers] as const,
  );
}

test("every main screen fits, with a picture of each", async ({ page }) => {
  const sizes = SIZES[test.info().project.name];
  test.skip(!sizes, "Sizes are set by the test itself.");
  test.setTimeout(240_000);
  const dir = process.env.CT_SHOTS;
  const found: string[] = [];
  await page.goto("/#/");
  const t = await given(page);
  for (const size of sizes) {
    const tag = `${size.width}x${size.height}`;
    const phone = size.width <= 760;
    const touchSized = size.width <= 760;
    let n = 0;
    const look = async (name: string) => {
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 60)))));
      for (const m of await misfits(page, size, touchSized)) found.push(`${tag} ${name}: ${m}`);
      if (dir) await page.screenshot({ path: join(dir, `${tag}-${String(++n).padStart(2, "0")}-${name}.png`), animations: "disabled" });
    };
    const go = async (hash: string) => {
      await page.goto(`/#${hash}`);
      await expect(page.locator(".topbar").first()).toBeVisible();
    };
    await page.setViewportSize(size);
    await page.goto("/#/");
    await page.waitForLoadState("networkidle");
    await page.reload();
    await expect(page.locator(".topbar").first()).toBeVisible();
    await look("home");
    await go("/agent/claude");
    await look("agent");

    // The long chat: its end, its long reply, a reply's actions.
    await go(`/room/${t.ids.long}`);
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(input).toBeVisible();
    await expect(page.locator(".messages").getByText("1,204,331 rows imported")).toBeVisible();
    await look("chat-end");
    await page.locator(".messages").getByText("What changed").scrollIntoViewIfNeeded();
    await page.locator(".messages").evaluate((sc) => (sc.scrollTop -= 60));
    await look("chat-long-reply");
    // Tapped: the long reply's actions are in reach without scrolling to its end.
    await page.locator(".messages").getByText("The importer now reads the file").click();
    await look("chat-reply-actions");
    const copy = page.locator(".your-msg.open .msg-actions").getByRole("button", { name: /^Copy/ }).first();
    await expect(copy).toBeVisible();
    const inView = await copy.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const box = el.closest(".messages")!.getBoundingClientRect();
      return r.top >= box.top && r.bottom <= box.bottom + 1;
    });
    if (!inView) found.push(`${tag} chat-reply-actions: a long reply's actions opened out of sight`);
    await page.locator(".messages").getByText("The importer now reads the file").click();
    await page.locator(".messages").getByText("customers-2026-11.png").first().scrollIntoViewIfNeeded();
    await look("chat-picture");
    await input.fill("A message being typed that is long enough to wrap onto a second line on a phone, and then some more.");
    await look("chat-typing");
    await input.fill("");

    await page.getByRole("button", { name: "Chat settings" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await look("chat-settings");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await go(`/room/${t.ids.work}`);
    await expect(input).toBeVisible();
    await look("chat-working");
    await go(`/room/${t.ids.failed}`);
    await expect(page.locator(".messages").getByText("stream disconnected").first()).toBeVisible();
    await look("chat-failed");
    await go(`/room/${t.ids.group}`);
    await expect(input).toBeVisible();
    await look("group-working");
    await input.fill("@codex what do you think of the second step?");
    await look("group-typing");
    // The box keeps room to type in beside its buttons.
    const typing = (await input.boundingBox())!.width;
    if (typing < Math.min(size.width, 880) * 0.42) found.push(`${tag} group-typing: the message box is ${Math.round(typing)}px wide`);
    await input.fill("");

    // The chats: a drawer on a phone, beside the screen otherwise. New chat from there.
    if (phone) {
      await page.getByRole("button", { name: /^Show chats/ }).click();
      await expect(page.locator(".chat-sidebar.drawer")).toBeVisible();
    }
    await look("chats");
    await page.locator(".chat-sidebar .csb-new").click();
    await look("new-chat-menu");
    await page.getByRole("menuitem", { name: /Claude Code/ }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await look("new-chat");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    if (phone && (await page.locator(".chat-sidebar.drawer").count())) await page.keyboard.press("Escape");

    await go("/settings");
    await expect(page.locator("#settings-panel")).toBeVisible();
    await look("settings");
    for (const section of ["ai-services", "defaults", "teamwork", "usage", "display", "machines", "local-models"]) {
      await page.goto(`/#/settings/${section}`);
      await expect(page.locator("#settings-panel")).toBeVisible();
      await look(`settings-${section}`);
    }
    await go("/bookmarks");
    await look("bookmarks");
    await go("/terminal");
    await look("terminal");
    await go("/screen");
    await look("screen");
  }
  expect(found).toEqual([]);
});
