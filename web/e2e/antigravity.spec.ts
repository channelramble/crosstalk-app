import { test, expect, noHorizontalOverflow } from "./fixtures";

test("the current chooser and settings offer supported chat agents even with legacy providers installed", async ({ page }) => {
  await page.route("**/api/state", async (route) => {
    const snap = await (await route.fetch()).json();
    snap.providers.push({ provider: "antigravity", installed: true, signedIn: true, checkedAt: Date.now(), version: "test", binPath: "/test/agy" });
    await route.fulfill({ json: snap });
  });
  await page.goto("/");
  await expect(page.locator(".agent-picker .agent-card-name")).toHaveText(["Claude Code", "Codex"]);
  await noHorizontalOverflow(page);
  await page.getByRole("button", { name: "Settings", exact: true }).last().click();
  await expect(page.getByRole("region", { name: "Claude Code accounts", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Codex accounts", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Antigravity CLI accounts", exact: true })).toHaveCount(0);
  await noHorizontalOverflow(page);
});
