import { test, expect, noHorizontalOverflow, openGroupSettings } from "./fixtures";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("folder picker uploads whole folders, lists them, downloads and removes unsent folders", async ({ page, request, token }) => {
  const auth = { authorization: `Bearer ${token}` };
  const room = await (await request.post("http://127.0.0.1:8451/api/rooms", { headers: auth, data: { name: "Folder browser test", mode: "direct" } })).json();
  await request.post(`http://127.0.0.1:8451/api/rooms/${room.id}/members`, { headers: auth, data: { provider: "mock" } });
  const dir = mkdtempSync(join(tmpdir(), "ct-picker-"));
  const folder = join(dir, "my (project)");
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "Résumé & notes #1.txt"), "unicode file");
  writeFileSync(join(folder, "dist", "build output.txt"), "build output preserved");
  try {
    await page.goto(`/#/room/${room.id}`);
    await page.locator('input[aria-label="Choose a folder"]').setInputFiles(folder);
    const pending = page.getByLabel("Attached folders", { exact: true });
    await expect(pending.getByText("Ready", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Remove folder my (project)", exact: true }).click();
    await expect(pending).toHaveCount(0);
    await page.locator('input[aria-label="Choose a folder"]').setInputFiles(folder);
    await expect(pending.getByText("Ready", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("button", { name: "my (project)/", exact: true }).click();
    const file = page.locator('button[title="Download dist/build output.txt"]');
    await expect(file).toBeVisible();
    await expect(page.locator('button[title="Download Résumé & notes #1.txt"]')).toBeVisible();
    // An unrelated room update rerenders Markdown while this folder is open.
    // Previously this remounted the renderer and silently collapsed the card.
    await request.patch(`http://127.0.0.1:8451/api/rooms/${room.id}`, { headers: auth, data: { name: "Folder remains open" } });
    await expect(page.locator(".topbar h1")).toHaveText("Folder remains open");
    await expect(file).toBeVisible();
    await noHorizontalOverflow(page);
    const downloading = page.waitForEvent("download");
    await file.click();
    expect(readFileSync((await (await downloading).path())!, "utf8")).toBe("build output preserved");
  } finally {
    await request.delete(`http://127.0.0.1:8451/api/rooms/${room.id}`, { headers: auth });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a group chat's settings keep dirty edits, save exact review limits and open an agent by keyboard", async ({ page, request, token }, testInfo) => {
  const auth = { authorization: `Bearer ${token}` };
  const room = await (await request.post("http://127.0.0.1:8451/api/rooms", { headers: auth, data: { name: "Settings browser test", mode: "review" } })).json();
  await request.post(`http://127.0.0.1:8451/api/rooms/${room.id}/members`, { headers: auth, data: { provider: "mock", handle: "tester" } });
  try {
    await page.goto(`/#/room/${room.id}`);
    // A room is a group chat now: its settings are the chat's.
    const dialog = await openGroupSettings(page);
    await expect(dialog).toHaveCSS("opacity", "1");
    await dialog.screenshot({ path: testInfo.outputPath("group-settings.png") });
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Renamed browser room");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Renamed browser room");
    await expect(dialog.getByRole("radio", { name: /^Build & review/ })).toHaveAttribute("aria-checked", "true");
    await dialog.getByRole("button", { name: "Increase review rounds", exact: true }).click();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".topbar h1")).toHaveText("Renamed browser room");
    const history = await (await request.get(`http://127.0.0.1:8451/api/rooms/${room.id}/history`, { headers: auth })).json();
    expect(history.room.maxHops).toBe((Math.ceil(room.maxHops / 2) + 1) * 2 - 1);
    // Its agents are in its settings, the lead marked; one opens with the keyboard.
    const settings = await openGroupSettings(page);
    const row = settings.getByRole("listitem").filter({ hasText: "@tester" });
    await expect(row).toContainText("Lead");
    await row.getByRole("button", { name: "Change @tester", exact: true }).focus();
    await page.keyboard.press("Space");
    await expect(page.getByRole("dialog", { name: "@tester", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Already the lead", exact: true })).toBeDisabled();
    await noHorizontalOverflow(page);
  } finally { await request.delete(`http://127.0.0.1:8451/api/rooms/${room.id}`, { headers: auth }); }
});

test("a group chat (an older group room too) always has a way back to the other chats", async ({ page, request, token }) => {
  const auth = { authorization: `Bearer ${token}` };
  const room = await (await request.post("http://127.0.0.1:8451/api/rooms", { headers: auth, data: { name: "Way back", mode: "direct" } })).json();
  try {
    await page.goto(`/#/room/${room.id}`);
    await expect(page.locator(".topbar h1")).toHaveText("Way back");
    if (page.viewportSize()!.width <= 760) {
      // The chats drawer, where it's listed with the group chats, and Home from there.
      await page.getByRole("button", { name: /^Show chats/ }).click();
      const drawer = page.getByRole("complementary", { name: "Chats", exact: true });
      await expect(drawer.getByRole("region", { name: "Group chats", exact: true })).toContainText("Way back");
      await drawer.getByRole("button", { name: "Home", exact: true }).click();
      await expect(page.locator(".topbar h1")).toHaveText("Crosstalk");
    } else {
      // A hidden sidebar comes back from the room's own top bar.
      const sidebar = page.getByRole("complementary", { name: "Chats", exact: true });
      await sidebar.getByRole("button", { name: "Hide sidebar", exact: true }).click();
      await expect(sidebar).toHaveCount(0);
      const show = page.getByRole("button", { name: "Show chats", exact: true });
      await expect(show).toBeVisible();
      await show.click();
      await expect(sidebar).toBeVisible();
      await expect(page.locator(".topbar h1")).toHaveText("Way back");
    }
  } finally { await request.delete(`http://127.0.0.1:8451/api/rooms/${room.id}`, { headers: auth }); }
});

test("the last terminal can be closed, and a failed close stays available for retry", async ({ page }) => {
  const info = { id: "fixture-shell", title: "Shell", cols: 80, rows: 24, alive: true, createdAt: Date.now(), exitCode: null };
  let fail = true;
  await page.route("**/api/pty**", (route) => {
    const method = route.request().method();
    return route.fulfill(method === "DELETE" ? fail ? { status: 503, json: { error: "Could not close shell" } } : { json: { ok: true } } : method === "POST" ? { json: info } : { json: { info, scrollback: "Browser terminal fixture\r\n" } });
  });
  await page.goto("/#/terminal");
  await page.getByRole("button", { name: "Open a shell", exact: true }).click();
  const close = page.getByRole("button", { name: "Close shell 1", exact: true });
  await close.click();
  await expect(page.getByText("Could not close shell", { exact: true })).toBeVisible();
  await expect(close).toBeEnabled();
  fail = false;
  await close.click();
  await expect(page.getByText("No shell open", { exact: true })).toBeVisible();
});

test("device pairing failures can be retried without leaving the dialog", async ({ page }) => {
  let fail = true;
  await page.route("**/api/pairing-codes", (route) => route.fulfill(fail ? { status: 503, json: { error: "Pairing is temporarily unavailable" } } : { json: { code: "ABCD-EFGH", expiresAt: Date.now() + 60_000, url: null } }));
  await page.goto("/#/devices");
  await page.getByRole("button", { name: "Pair a new device", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Pairing is temporarily unavailable");
  fail = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("ABCD-EFGH");
});

test("pasted images and dropped files upload before send and display intact", async ({ page, request, token }) => {
  const auth = { authorization: `Bearer ${token}` };
  const room = await (await request.post("http://127.0.0.1:8451/api/rooms", { headers: auth, data: { name: "Paste and drop", mode: "direct" } })).json();
  await request.post(`http://127.0.0.1:8451/api/rooms/${room.id}/members`, { headers: auth, data: { provider: "mock", config: { delayMs: 0 } } });
  try {
    await page.goto(`/#/room/${room.id}`);
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await message.fill("Image and file");
    // Exercise clipboard/drop handlers without changing the user's clipboard.
    await message.evaluate((el) => {
      const data = new DataTransfer();
      const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFoQAAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
      data.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await page.locator(".composer").evaluate((el) => {
      const data = new DataTransfer();
      data.items.add(new File(["dropped intact"], "dropped.txt", { type: "text/plain" }));
      el.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    await expect(page.getByLabel("Attachments", { exact: true }).getByText("Ready", { exact: true })).toHaveCount(2);
    await expect(message).toHaveValue("Image and file");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const image = page.getByRole("img", { name: "pasted.png", exact: true });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1);
    await expect(page.getByRole("button", { name: "dropped.txt", exact: true })).toBeVisible();
    await noHorizontalOverflow(page);
  } finally { await request.delete(`http://127.0.0.1:8451/api/rooms/${room.id}`, { headers: auth }); }
});

test("failed attachments block sending and Retry completes the real upload", async ({ page, request, token }) => {
  const auth = { authorization: `Bearer ${token}` };
  const room = await (await request.post("http://127.0.0.1:8451/api/rooms", { headers: auth, data: { name: "Upload retry", mode: "direct" } })).json();
  await request.post(`http://127.0.0.1:8451/api/rooms/${room.id}/members`, { headers: auth, data: { provider: "mock", config: { delayMs: 0 } } });
  let attempts = 0;
  await page.route("**/uploads?name=*", (route) => ++attempts === 1 ? route.fulfill({ status: 503, json: { error: "Upload interrupted" } }) : route.continue());
  try {
    await page.goto(`/#/room/${room.id}`);
    await page.locator('input[aria-label="Choose attachments"]').setInputFiles({ name: "retry.txt", mimeType: "text/plain", buffer: Buffer.from("retry intact") });
    const pending = page.getByLabel("Attachments", { exact: true });
    await expect(pending).toContainText("Upload interrupted");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const history = await (await request.get(`http://127.0.0.1:8451/api/rooms/${room.id}/history`, { headers: auth })).json();
    expect(history.messages.filter((m: { role: string }) => m.role === "human")).toHaveLength(0);
    await pending.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(pending.getByText("Ready", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("button", { name: "retry.txt", exact: true })).toBeVisible();
    expect(attempts).toBe(2);
  } finally { await request.delete(`http://127.0.0.1:8451/api/rooms/${room.id}`, { headers: auth }); }
});

test("live work exposes a persistent approval button and denying resumes the turn", async ({ page, request, token }) => {
  const auth = { authorization: `Bearer ${token}` };
  const room = await (await request.post("http://127.0.0.1:8451/api/rooms", { headers: auth, data: { name: "Approval browser test", mode: "direct" } })).json();
  await request.post(`http://127.0.0.1:8451/api/rooms/${room.id}/members`, { headers: auth, data: { provider: "mock", handle: "reviewer", config: { approval: true, delayMs: 100 } } });
  try {
    await page.goto(`/#/room/${room.id}`);
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Check this fixture");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    // A group chat's status line names the agent at work.
    await expect(page.getByRole("button", { name: /^@reviewer: / })).toBeVisible();
    await page.getByRole("button", { name: "Review approval (1)", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Approvals · Approval browser test", exact: true });
    await expect(dialog).toContainText("npm test");
    await dialog.getByRole("button", { name: "Deny", exact: true }).click();
    await expect(dialog).toContainText("Nothing is waiting for your approval");
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByRole("button", { name: "Review approval (1)", exact: true })).toHaveCount(0);
    await noHorizontalOverflow(page);
  } finally { await request.delete(`http://127.0.0.1:8451/api/rooms/${room.id}`, { headers: auth }); }
});

test("the lead a group chat's settings pick answers, parallel work is kept, and agents never hand off by themselves", async ({ page, request, token }) => {
  const auth = { authorization: `Bearer ${token}` };
  const room = await (await request.post("http://127.0.0.1:8451/api/rooms", { headers: auth, data: { name: "Simple teamwork", mode: "direct" } })).json();
  await request.post(`http://127.0.0.1:8451/api/rooms/${room.id}/members`, { headers: auth, data: { provider: "mock", handle: "first", config: { delayMs: 20, reply: "First agent answered." } } });
  const chosen = await (await request.post(`http://127.0.0.1:8451/api/rooms/${room.id}/members`, { headers: auth, data: { provider: "mock", handle: "chosen", config: { delayMs: 20, reply: "Default agent handled it. @first please review." } } })).json();
  try {
    await page.goto(`/#/room/${room.id}`);
    const dialog = await openGroupSettings(page);
    await expect(dialog.getByRole("radio")).toHaveCount(3);
    await expect(dialog.getByRole("radio", { name: /^The lead answers/ })).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByRole("group", { name: "review rounds", exact: true })).toHaveCount(0);
    await dialog.getByRole("combobox", { name: "Lead", exact: true }).selectOption(chosen.id);
    await dialog.getByRole("checkbox", { name: "Let agents work at the same time", exact: true }).check();
    await expect(dialog).toContainText("divide file ownership");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    // Who answers is said above the message box, and the header names the agents.
    await expect(page.locator(".group-answers")).toHaveText("@chosen answers. Type @ to pick who answers.");
    await expect(page.locator(".topbar .sub")).toContainText("@first and @chosen");
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Handle this request");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(async () => {
      const history = await (await request.get(`http://127.0.0.1:8451/api/rooms/${room.id}/history`, { headers: auth })).json();
      return history.turns.filter((t: { status: string }) => t.status === "done").length;
    }).toBe(1);
    const history = await (await request.get(`http://127.0.0.1:8451/api/rooms/${room.id}/history`, { headers: auth })).json();
    expect(history.room.parallel).toBe(true);
    expect(history.room.leadMemberId).toBe(chosen.id);
    expect(history.turns.map((t: { memberId: string }) => t.memberId)).toEqual([chosen.id]);
    await noHorizontalOverflow(page);
  } finally { await request.delete(`http://127.0.0.1:8451/api/rooms/${room.id}`, { headers: auth }); }
});
