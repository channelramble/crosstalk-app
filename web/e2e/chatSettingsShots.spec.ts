import { join } from "node:path";
import { test, expect, chatSettings, openFold, settingsTab } from "./fixtures";
import type { Page } from "@playwright/test";

// Pictures of every place a chat and its agent are set up, to look at: CT_SHOTS=/some/dir saves them (skipped without).
const HUB = "http://127.0.0.1:8451";

const CLAUDE = {
  provider: "claude",
  accountId: "default",
  live: true,
  error: null,
  models: [
    { id: "opus", resolvedModel: "claude-opus-5-5", label: "Opus 5.5", description: "Most capable, for complex work", isDefault: true, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: null, contextWindow: 1_000_000, fast: { label: "Fast", description: "About twice as fast. Uses your plan faster." } },
    { id: "sonnet", resolvedModel: "claude-sonnet-5", label: "Sonnet 5", description: "Best for everyday tasks", isDefault: false, efforts: ["low", "medium", "high"], defaultEffort: null, contextWindow: 200_000 },
    { id: "haiku", resolvedModel: "claude-haiku-4-5", label: "Haiku 4.5", description: "Fastest for quick answers", isDefault: false, efforts: [], defaultEffort: null, contextWindow: 200_000 },
    { id: "opus-4", resolvedModel: "claude-opus-4-1", label: "Opus 4.1", description: "An older model", isDefault: false, more: true, efforts: ["low", "high"], defaultEffort: null, contextWindow: 200_000 },
  ],
};

test("pictures of a chat's settings", async ({ page, request, token }) => {
  const dir = process.env.CT_SHOTS;
  test.skip(!dir, "Set CT_SHOTS to a folder to save the pictures in.");
  test.setTimeout(180_000);
  const headers = { authorization: `Bearer ${token}` };
  const tag = test.info().project.name.replace("chromium-", "");
  let n = 0;
  const shot = async (name: string) => {
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 80)))));
    await page.screenshot({ path: join(dir!, `${tag}-${String(++n).padStart(2, "0")}-${name}.png`), animations: "disabled" });
  };
  const step = async (name: string, fn: (page: Page) => Promise<unknown>) => {
    try {
      await fn(page);
      await shot(name);
    } catch (e) {
      console.log(`${tag} ${name}: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    }
    for (let i = 0; i < 4 && (await page.getByRole("dialog").count()); i++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(80);
    }
    await expect(page.getByRole("dialog")).toHaveCount(0);
  };
  await page.route("**/api/providers/claude/models**", (r) => r.fulfill({ json: CLAUDE }));
  const one = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "claude", name: "Importer fix" } })).json();
  const group = await (await request.post(`${HUB}/api/chats/group`, { headers, data: { name: "Build and check", members: [{ provider: "claude" }, { provider: "codex", handle: "checker" }], answers: "lead" } })).json();
  await page.goto(`/#/room/${one.id}`);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await shot("chat-row");
  await step("sheet-overview", (p) => chatSettings(p));
  await step("chip-model", (p) => p.locator(".chat-controls .ctl-model").click());
  await step("chip-permissions", (p) => p.getByRole("button", { name: /^Permissions:/ }).click());
  await step("ring-memory", (p) => p.locator(".chat-controls .ring-btn").click());
  await step("answers-end", async (p) => {
    const region = await chatSettings(p, "Answers with");
    await region.evaluate((el) => el.scrollIntoView({ block: "end" }));
  });
  await step("helpers", (p) => chatSettings(p, "Helpers"));
  await step("this-chat", async (p) => {
    const region = await chatSettings(p, "This chat");
    await region.evaluate((el) => el.scrollIntoView({ block: "end" }));
  });
  await step("full-access-asks", async (p) => {
    const region = await chatSettings(p, "May do");
    await region.locator('[role="radio"][data-value="full"]').click();
    await expect(p.getByRole("dialog", { name: /full access/ })).toBeVisible();
  });
  await page.goto(`/#/room/${group.id}`);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await shot("group-row");
  await step("group-overview", (p) => chatSettings(p));
  await step("group-together", async (p) => openFold(await chatSettings(p), "Working together"));
  await step("group-agent", async (p) => openFold(await chatSettings(p), "@claude"));
  await step("group-agent-answers", (p) => chatSettings(p, "Answers with", "checker"));
  await step("group-agent-name", (p) => chatSettings(p, "Name and role", "claude"));
  await page.goto("/#/agent/claude");
  await step("new-chat", async (p) => {
    await p.getByRole("button", { name: "New chat", exact: true }).last().click();
    await expect(p.getByRole("dialog").last()).toBeVisible();
    await p.getByText("Answers with", { exact: true }).evaluate((el) => el.scrollIntoView({ block: "start" }));
  });
  await step("new-chat-end", async (p) => {
    await p.getByRole("button", { name: "New chat", exact: true }).last().click();
    await p.locator(".dialog-body").last().evaluate((el) => el.scrollTo(0, el.scrollHeight));
  });
  await page.goto("/#/settings");
  await step("settings-new-chats", async (p) => {
    const region = await settingsTab(p, "New chats");
    await region.locator("details.defaults-card summary").first().click();
  });
});
