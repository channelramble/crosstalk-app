import type { Page } from "@playwright/test";
import type { MachineMemory } from "@crosstalk/shared";
import { test, expect, noHorizontalOverflow } from "./fixtures";

// Settings → Memory (web/src/views/MemorySection.tsx, hub/src/memory.ts): the card that appears while the hub's
// machine is running out, what it offers, and that it goes away again.
//
// The test hub keeps nothing on disk, so its memory guard is deliberately blind (it never reads this Mac and never
// refuses anything). The state the card draws is therefore put on the app's own store, exactly as a `memory` event
// from a hub would: that exercises the real component, the real store field and the real link into Settings, and
// nothing here reads, starts or stops anything of the user's.

const GiB = 1024 ** 3;

/**
 * The store module the app itself loaded. Once anything under src/ has been saved while the dev server runs, a bare
 * import of "/src/store.ts" is a second, empty copy of the module (see reconnectReliability.spec.ts).
 */
async function appStore(page: Page): Promise<string> {
  const path = await page.evaluate(async () => {
    const main = await (await fetch("/src/main.tsx")).text();
    return /from\s*"(\/src\/store\.ts[^"]*)"/.exec(main)?.[1] ?? "/src/store.ts";
  });
  await expect
    .poll(() => page.evaluate(async (p) => {
      try {
        return !!(await import(p)).useStore.getState().conn;
      } catch {
        return false;
      }
    }, path), { message: `${path} isn't the app's own store: the app has another copy of the module` })
    .toBe(true);
  return path;
}

const say = (page: Page, path: string, memory: MachineMemory | null) =>
  page.evaluate(async ([p, m]) => (await import(p as string)).useStore.setState({ memory: m }), [path, memory] as const);

/** A machine that has run out: two model servers on a 16 GB Mac. */
const squeezed = (over: Partial<MachineMemory> = {}): MachineMemory => ({
  band: "full",
  level: 18,
  blind: null,
  ramBytes: 16 * GiB,
  takenBytes: Math.round(20.7 * GiB),
  swapPagesPerSec: 18_000,
  swapUsedBytes: Math.round(9.6 * GiB),
  holders: [
    // One Crosstalk started (it can be turned off from here) and one the person started (it can't).
    { what: "llama.cpp on port 9000", ours: true, section: "local-models", bytes: Math.round(16.9 * GiB) },
    { what: "the model server on port 8080", ours: false, section: null, bytes: Math.round(3.8 * GiB) },
  ],
  at: Date.now(),
  ...over,
});

test("the memory card appears when the machine runs out, names what's holding it, and goes when it's fine again", async ({ page }) => {
  await page.goto("/#/settings/local-models");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  const path = await appStore(page);
  // Nothing to say: no card (a hub that can't read its machine shows nothing either).
  await expect(page.getByRole("heading", { name: "Memory" })).toHaveCount(0);
  await say(page, path, squeezed({ band: "unknown", blind: "Crosstalk only watches memory on macOS and Linux hubs." }));
  await expect(page.getByRole("heading", { name: "Memory" })).toHaveCount(0);

  await say(page, path, squeezed());
  const card = page.locator(".memory-card");
  await expect(page.getByRole("heading", { name: "Memory" })).toBeVisible();
  await expect(card).toContainText("is out of memory");
  await expect(card).toContainText("llama.cpp on port 9000 (16.9 GB)");
  await expect(card).toContainText("9.6 GB has moved to the disk");
  await expect(card).toContainText("Crosstalk never stops anything by itself");
  // The person's own server gets words, not a button: the hub never ends what it didn't start.
  await expect(card.getByRole("button", { name: /model server on port 8080/i })).toHaveCount(0);
  await expect(card).toContainText("Quit it on");
  await expect(page.locator("#memory .pill")).toHaveText("Full");
  // It fits a phone.
  await noHorizontalOverflow(page);

  // The one thing Crosstalk can turn off is one tap from here.
  await card.getByRole("button", { name: "Turn llama.cpp on port 9000 off" }).click();
  await expect(page.locator("#local-models")).toBeInViewport();

  // The machine recovers: the card goes away rather than sitting there saying nothing.
  await say(page, path, squeezed({ band: "fine", holders: [], swapPagesPerSec: 0 }));
  await expect(page.getByRole("heading", { name: "Memory" })).toHaveCount(0);
  await say(page, path, null);
});
