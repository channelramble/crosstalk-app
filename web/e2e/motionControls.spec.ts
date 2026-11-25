import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, chatSettings } from "./fixtures";

/*
 * Motion for sheets on every screen size and for the controls of the Chat settings sheet
 * (web/src/styles/motion-controls.css, motion.ts `useGlide` and `fallOf`):
 * - a sheet rises in, and its copy drops off the screen whole when it closes, from the bottom edge of a phone and
 *   from the middle of a computer's window, where it used to stop half way down and hang there;
 * - a section of the sheet opening: its arrow turns, what's in it drops in, and what's under it glides out of its way,
 *   the sheet too; closing, the rest glides back;
 * - the sheet's rows, cards and steps answer a press as every other button does;
 * - under Reduce Motion none of it moves.
 */

const HUB = "http://127.0.0.1:8451";
/** Fades and colour, as script names them: allowed under either setting. */
const PAINTS = /^(opacity|color|backgroundColor|boxShadow|border(Top|Right|Bottom|Left)?Color|outlineColor)$/;
const MOVES_OR_PAINTS = /^(transform|translate|scale|rotate|opacity|color|backgroundColor|boxShadow|border(Top|Right|Bottom|Left)?Color|outlineColor)$/;

async function chat(page: Page, request: APIRequestContext, token: string) {
  const headers = { authorization: `Bearer ${token}` };
  const room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "claude", name: "Moving parts" } })).json();
  await page.goto(`/#/room/${room.id}`);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  return { room, cleanup: () => request.delete(`${HUB}/api/rooms/${room.id}`, { headers }) };
}

/** Every animation on the page that ends, held at `at` of its way (0 to 1). */
const hold = (page: Page, at: number) =>
  page.evaluate((at) => {
    for (const a of document.getAnimations()) {
      const t = a.effect?.getComputedTiming();
      if (!t || t.iterations === Infinity) continue;
      a.pause();
      a.currentTime = Number(t.endTime) * at;
    }
  }, at);
const letGo = (page: Page) => page.evaluate(() => document.getAnimations().forEach((a) => a.effect?.getComputedTiming().iterations !== Infinity && a.finish()));
/** What moves by script right now (a glide), as "tag.class" of each thing moving. */
const gliding = (page: Page) =>
  page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => !("animationName" in a) && !("transitionProperty" in a))
      .map((a) => {
        const el = (a.effect as KeyframeEffect).target as HTMLElement | null;
        return `${el?.localName}.${String(el?.className ?? "").trim().split(/\s+/)[0]}`;
      }),
  );

test.describe("with motion", () => {
  test.use({ reducedMotion: "no-preference" });

  test("a sheet rises in and, closed, its copy drops off the screen whole, wherever it sat", async ({ page, request, token }) => {
    const c = await chat(page, request, token);
    try {
      await page.addStyleTag({ content: ":root { --dur-sheet-in: 60s; --dur-sheet-out: 60s; }" });
      await page.getByRole("button", { name: "Chat settings", exact: true }).click();
      const sheet = page.getByRole("dialog", { name: "Chat settings", exact: true });
      await expect(sheet).toBeVisible();
      // Coming in, on a phone and on a computer alike.
      expect(await sheet.evaluate((d) => d.getAnimations().map((a) => (a as CSSAnimation).animationName))).toContain("m-sheet-in");
      await letGo(page);
      const screen = page.viewportSize()!;
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
      // Its copy, at the end of its way out: all of it under the bottom edge of the screen.
      const end = await page.evaluate(async () => {
        const { ghosts } = await import("/src/motion.ts" as string);
        const copy = (ghosts() as HTMLElement[]).find((g) => g.dataset.ghost === "sheet");
        const part = copy?.querySelector<HTMLElement>(".dialog");
        if (!part) return null;
        for (const a of part.getAnimations()) {
          a.pause();
          a.currentTime = Number(a.effect!.getComputedTiming().endTime) - 1;
        }
        const r = part.getBoundingClientRect();
        return { top: r.top, name: part.getAnimations().map((a) => (a as CSSAnimation).animationName) };
      });
      expect(end?.name).toContain("m-sheet-out");
      expect(end!.top).toBeGreaterThanOrEqual(screen.height - 1);
      // And then it's gone.
      await page.evaluate(async () => {
        const { ghosts } = await import("/src/motion.ts" as string);
        for (const copy of ghosts() as HTMLElement[]) for (const a of copy.getAnimations({ subtree: true })) a.finish();
      });
      await expect(page.locator("[data-ghost]")).toHaveCount(0);
    } finally {
      await c.cleanup();
    }
  });

  test("a section opening: its arrow turns, what's in it drops in, and the rest glides out of its way and back", async ({ page, request, token }) => {
    const c = await chat(page, request, token);
    try {
      const sheet = await chatSettings(page);
      await letGo(page);
      await page.addStyleTag({ content: ":root { --dur-flip: 60s; --dur-enter: 60s; --dur-rotate: 60s; }" });
      const may = sheet.getByRole("region", { name: "May do", exact: true });
      const below = sheet.getByRole("region", { name: "Helpers", exact: true });
      const top = async () => (await below.boundingBox())!.y;
      const was = { below: await top(), sheet: (await sheet.boundingBox())!.y };
      await may.locator("> .cs-fold-head").click();
      // Open at once: its choices take a tap from the first frame.
      await expect(may.locator("> .cs-fold-body")).toBeVisible();
      expect(await may.locator("> .cs-fold-body").evaluate((b) => b.getAnimations().map((a) => (a as CSSAnimation).animationName))).toContain("m-drop-in");
      expect(await may.locator(".cs-fold-chevron").first().evaluate((ch) => getComputedStyle(ch).transitionProperty)).toContain("transform");
      // What's under it starts where it was on the screen, and so does the sheet: both are on their way, by transform alone.
      await hold(page, 0);
      const moving = await gliding(page);
      expect(moving).toContain("section.cs-fold");
      expect(Math.abs((await top()) - was.below)).toBeLessThan(3);
      expect(Math.abs((await sheet.boundingBox())!.y - was.sheet)).toBeLessThan(3);
      const props = await page.evaluate(() => [...new Set(document.getAnimations().flatMap((a) => (a.effect as KeyframeEffect).getKeyframes().flatMap((k) => Object.keys(k))))].filter((k) => !["offset", "easing", "composite", "computedOffset"].includes(k)));
      // Only transform and opacity move; a colour may change on a small control.
      expect(props.filter((p) => !MOVES_OR_PAINTS.test(p))).toEqual([]);
      await letGo(page);
      const open = await top();
      expect(open).toBeGreaterThan(was.below + 40);
      // Closing: the rest glides back from where it was, and on a phone nothing shows under the sheet as it eases down.
      await may.locator("> .cs-fold-head").click();
      await expect(may.locator("> .cs-fold-body")).toHaveCount(0);
      await hold(page, 0);
      expect(Math.abs((await top()) - open)).toBeLessThan(3);
      const phone = (page.viewportSize()?.width ?? 0) <= 760;
      if (phone) {
        const strip = page.locator("[data-under-sheet]");
        await expect(strip).toHaveCount(1);
        const s = (await strip.boundingBox())!;
        const d = (await sheet.boundingBox())!;
        expect(Math.abs(s.y - (d.y + d.height))).toBeLessThan(2);
        expect(Math.abs(s.y + s.height - page.viewportSize()!.height)).toBeLessThan(2);
      }
      await letGo(page);
      expect(Math.abs((await top()) - was.below)).toBeLessThan(3);
      await expect(page.locator("[data-under-sheet]")).toHaveCount(0, { timeout: 3000 });
    } finally {
      await c.cleanup();
    }
  });

  test("the sheet's rows, cards and steps answer a press, and what's picked gets a tick that pops in", async ({ page, request, token }) => {
    const c = await chat(page, request, token);
    try {
      await page.addStyleTag({ content: ":root { --dur-flip: 60s; }" });
      const may = await chatSettings(page, "May do");
      // The sections under it are still gliding out of the way: its cards take the tap all the same.
      expect((await gliding(page)).length).toBeGreaterThan(0);
      const moves = (selector: string) => may.locator(selector).first().evaluate((el) => getComputedStyle(el).transitionProperty);
      expect(await moves(".cs-fold-head")).toContain("scale");
      expect(await moves(".cs-card")).toContain("scale");
      expect(await moves(".cs-card")).toContain("background-color");
      // Held down, a card is a touch smaller.
      const card = may.locator(".cs-card:not(.on)").first();
      const box = (await card.boundingBox())!;
      expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest(".cs-card"), [box.x + box.width / 2, box.y + box.height / 2])).toBe(true);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await expect.poll(() => card.evaluate((el) => getComputedStyle(el).scale)).not.toBe("none");
      await expect.poll(async () => (await card.boundingBox())!.width).toBeLessThan(box.width - 0.5);
      await page.mouse.move(2, 2);
      await page.mouse.up();
      expect(await may.locator(".cs-card.on > .cs-tick").evaluate((t) => t.getAnimations().map((a) => (a as CSSAnimation).animationName))).toContain("m-pop-in");
    } finally {
      await c.cleanup();
    }
  });
});

test.describe("with Reduce Motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("a section opens and closes in place: nothing glides, nothing shrinks, and a closed sheet leaves no copy", async ({ page, request, token }) => {
    const c = await chat(page, request, token);
    try {
      const sheet = await chatSettings(page);
      const may = sheet.getByRole("region", { name: "May do", exact: true });
      await may.locator("> .cs-fold-head").click();
      await expect(may.locator("> .cs-fold-body")).toBeVisible();
      expect(await gliding(page)).toEqual([]);
      expect(await may.locator(".cs-card").first().evaluate((el) => getComputedStyle(el).transitionProperty)).not.toContain("scale");
      // What comes in fades, 150 ms or less.
      const fades = await page.evaluate(() => document.getAnimations().map((a) => ({ ms: Number(a.effect?.getComputedTiming().endTime), props: (a.effect as KeyframeEffect).getKeyframes().flatMap((k) => Object.keys(k)).filter((k) => !["offset", "easing", "composite", "computedOffset"].includes(k)) })));
      for (const f of fades) {
        expect(f.ms).toBeLessThanOrEqual(150);
        expect(f.props.filter((p) => !PAINTS.test(p))).toEqual([]);
      }
      await may.locator("> .cs-fold-head").click();
      expect(await gliding(page)).toEqual([]);
      await expect(page.locator("[data-under-sheet]")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
      await expect(page.locator("[data-ghost]")).toHaveCount(0);
    } finally {
      await c.cleanup();
    }
  });
});
