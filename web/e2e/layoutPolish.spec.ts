import type { Page } from "@playwright/test";
import { test, expect, noHorizontalOverflow } from "./fixtures";
import { given } from "./tourChats";

/*
 * What the layout does for a phone and for a computer, beyond fitting (layoutTour.spec.ts):
 * - phones: a long reply's actions open in reach; a group chat at work keeps its message box wide;
 * - computers: the chat list drags wider and narrower and stays as it was left; ⌘K / Ctrl+K searches the chats from
 *   anywhere, the arrow keys move through them and Enter opens one; ⌥N / Alt+N starts a chat; a chat that opens is
 *   ready to type in; files dropped anywhere on a chat are attached; an icon-only button says its name under the mouse.
 * The chats are made up for the page alone (tourChats.ts).
 */

const project = () => test.info().project.name;
const PHONES = ["chromium-320", "chromium-390", "chromium-430", "webkit-390"];
const COMPUTERS = ["chromium-1440"];

async function open(page: Page, hash = "/") {
  await page.goto("/#/");
  const t = await given(page);
  await page.waitForLoadState("networkidle");
  await page.reload();
  await page.goto(`/#${hash.replace("$long", `/room/${t.ids.long}`).replace("$group", `/room/${t.ids.group}`).replace("$work", `/room/${t.ids.work}`)}`);
  await expect(page.locator(".topbar").first()).toBeVisible();
  return t;
}

const input = (page: Page) => page.getByRole("textbox", { name: "Message", exact: true });
const widthOf = async (page: Page, selector: string) => Math.round((await page.locator(selector).first().boundingBox())!.width);

test.describe("on a phone", () => {
  test.beforeEach(() => {
    test.skip(!PHONES.includes(project()), "A phone's width");
  });

  test("a reply longer than the screen: tapped at its top, its actions are in reach at the foot of the messages, and under its last line once that's reached", async ({ page }) => {
    await open(page, "$long");
    const messages = page.locator(".messages");
    await expect(messages.getByText("1,204,331 rows imported")).toBeVisible();
    await messages.getByText("What changed").scrollIntoViewIfNeeded();
    // Tapped where it is (a finger doesn't scroll first): its first paragraph, in view near the top.
    const first = messages.getByText("The importer now reads the file");
    await first.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await messages.evaluate((el) => (el.scrollTop -= 80));
    const before = (await first.boundingBox())!;
    await page.mouse.click(before.x + 40, before.y + 8);
    const copy = page.locator(".your-msg.open .msg-actions").getByRole("button", { name: /^Copy/ }).first();
    await expect(copy).toBeVisible();
    // In sight without scrolling: the tap moved nothing under the finger.
    expect(Math.abs((await first.boundingBox())!.y - before.y)).toBeLessThan(2);
    const place = async () => {
      const r = (await copy.boundingBox())!;
      const box = (await messages.boundingBox())!;
      return { top: r.y - box.y, bottom: box.y + box.height - (r.y + r.height) };
    };
    const stuck = await place();
    expect(stuck.top).toBeGreaterThan(0);
    // Near the foot of the messages (a row or two of them), clear of Jump to latest under them.
    expect(stuck.bottom).toBeGreaterThanOrEqual(56);
    expect(stuck.bottom).toBeLessThan(170);
    const jump = (await page.getByRole("button", { name: /^Jump to latest/ }).boundingBox())!;
    for (const action of await page.locator(".your-msg.open .msg-actions button").all()) {
      const r = (await action.boundingBox())!;
      const apart = r.y + r.height <= jump.y + 1 || r.y >= jump.y + jump.height - 1 || r.x + r.width <= jump.x + 1 || r.x >= jump.x + jump.width - 1;
      expect(apart, `${await action.innerText()} is clear of Jump to latest`).toBe(true);
    }
    // Finger-sized, and they work from there.
    expect((await copy.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
    expect(jump.height).toBeGreaterThanOrEqual(43.5);
    // Scrolled to the reply's end, they sit under its last line, above the next message.
    await messages.getByText("Looks right. Run it for real.").scrollIntoViewIfNeeded();
    await messages.evaluate((el) => (el.scrollTop += 80));
    const next = (await messages.getByText("Looks right. Run it for real.").boundingBox())!;
    const settled = (await copy.boundingBox())!;
    expect(settled.y + settled.height).toBeLessThanOrEqual(next.y + 1);
    // A second tap puts them away.
    await messages.getByText("That's everything.").click();
    await expect(page.locator(".your-msg.open")).toHaveCount(0);
  });

  test("a group chat at work: the message box keeps its width with a draft, each agent's Stop is on its line, and Stop all is in the box when it's empty", async ({ page }) => {
    await open(page, "$group");
    await expect(input(page)).toBeVisible();
    const screen = page.viewportSize()!.width;
    // Nothing typed: Stop all where Send would be.
    await expect(page.getByRole("button", { name: "Stop all agents" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop @claude" })).toBeVisible();
    const empty = await widthOf(page, 'textarea[aria-label="Message"]');
    // A draft that names who answers: Send is its arrow (its name still says who), and the box is as wide as before.
    await input(page).fill("@codex what do you think of the second step?");
    const send = page.getByRole("button", { name: /^Send to @codex/ });
    await expect(send).toBeVisible();
    await expect(send.locator(".ask-label")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop all agents" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop @claude" })).toBeVisible();
    const typing = await widthOf(page, 'textarea[aria-label="Message"]');
    expect(typing).toBeGreaterThanOrEqual(empty - 2);
    expect(typing).toBeGreaterThan(screen * 0.45);
    // Who it goes to is said above the box.
    await expect(page.locator(".group-answers")).toContainText("@codex");
    await input(page).fill("");
    await expect(page.getByRole("button", { name: "Stop all agents" })).toBeVisible();
  });
});

test.describe("on a computer", () => {
  test.beforeEach(() => {
    test.skip(!COMPUTERS.includes(project()), "A computer's width");
  });

  test("the chat list's edge drags it wider and narrower, within limits; the width stays after a reload, and a double-click puts it back", async ({ page }) => {
    await open(page, "$long");
    const list = ".chat-sidebar:not(.drawer)";
    const edge = page.getByRole("separator", { name: "Chat list width" });
    await expect(edge).toBeVisible();
    expect(await widthOf(page, list)).toBe(272);
    const drag = async (to: number) => {
      const from = (await page.locator(list).boundingBox())!;
      await page.mouse.move(from.x + from.width, 300);
      await page.mouse.down();
      await page.mouse.move(to, 300, { steps: 6 });
      await page.mouse.up();
    };
    await drag(360);
    expect(await widthOf(page, list)).toBe(360);
    await expect(edge).toHaveAttribute("aria-valuenow", "360");
    // The chat beside it takes the rest, and nothing is wider than the window.
    const main = (await page.locator(".shell > .main").boundingBox())!;
    expect(Math.round(main.x)).toBe(360);
    expect(Math.round(main.x + main.width)).toBe(page.viewportSize()!.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
    // No further than its limits.
    await drag(40);
    expect(await widthOf(page, list)).toBe(220);
    await drag(900);
    expect(await widthOf(page, list)).toBe(480);
    await drag(330);
    // Kept on this device.
    await page.reload();
    await expect(page.locator(list)).toBeVisible();
    expect(await widthOf(page, list)).toBe(330);
    // With a keyboard: ← and → move it, Home and End go to its limits.
    await edge.focus();
    await page.keyboard.press("ArrowRight");
    expect(await widthOf(page, list)).toBe(346);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    expect(await widthOf(page, list)).toBe(314);
    await page.keyboard.press("Home");
    expect(await widthOf(page, list)).toBe(220);
    // A small window never gives the list so much that the chat beside it has less than a phone's width.
    await page.keyboard.press("End");
    await page.setViewportSize({ width: 800, height: 700 });
    expect(await widthOf(page, list)).toBe(380);
    await page.setViewportSize({ width: 1440, height: 900 });
    expect(await widthOf(page, list)).toBe(480);
    await edge.dblclick();
    expect(await widthOf(page, list)).toBe(272);
    await page.reload();
    await expect(page.locator(list)).toBeVisible();
    expect(await widthOf(page, list)).toBe(272);
  });

  test("Ctrl+K searches the chats from anywhere: the arrows move through them, Enter opens one, Esc gives the keyboard back to the message box", async ({ page }) => {
    await open(page, "$long");
    // A chat that opens is ready to type in.
    await expect(input(page)).toBeFocused();
    const search = page.getByRole("textbox", { name: "Search chats" });
    // The field says how to reach it.
    await expect(page.locator(".csb-key")).toHaveText(/K$/);
    await page.keyboard.press("Control+k");
    await expect(search).toBeFocused();
    await page.keyboard.type("login");
    await expect(page.locator(".csb-key")).toHaveCount(0);
    const rows = page.locator(".csb-scroll button.csb-chat");
    await expect(rows).toHaveCount(1);
    // Enter opens the chat it found; the search has done its job and the message box is ready.
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Fix the flaky login test" })).toBeVisible();
    await expect(search).toHaveValue("");
    await expect(input(page)).toBeFocused();
    // ⌘K too (a Mac's keyboard); ↓ goes into the list, ↓ and ↑ move, ↑ from the first goes back to the search.
    await page.keyboard.press("Meta+k");
    await expect(search).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(rows.nth(0)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(rows.nth(1)).toBeFocused();
    await page.keyboard.press("End");
    await expect(rows.last()).toBeFocused();
    await page.keyboard.press("Home");
    await expect(rows.nth(0)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(search).toBeFocused();
    // Esc empties a search first, then leaves it for the message box.
    await page.keyboard.type("zzz");
    await expect(page.getByText("No chats match.")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(search).toHaveValue("");
    await expect(search).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(input(page)).toBeFocused();
    // Enter on a chat reached with the arrows opens it.
    await page.keyboard.press("Control+k");
    await page.keyboard.press("ArrowDown");
    const name = await rows.nth(0).locator(".csb-chat-name").innerText();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name })).toBeVisible();
    // Hidden, the list comes back for it.
    await page.getByRole("button", { name: "Hide sidebar" }).click();
    await expect(page.locator(".chat-sidebar")).toHaveCount(0);
    await page.keyboard.press("Control+k");
    await expect(search).toBeFocused();
    // Not from under a sheet: it has the keyboard.
    await page.getByRole("button", { name: "Chat settings" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Control+k");
    await expect(search).not.toBeFocused();
    await page.keyboard.press("Escape");
  });

  test("Alt+N opens New chat with its first choice ready, and Esc closes it", async ({ page }) => {
    await open(page, "$long");
    await expect(page.locator(".csb-new")).toHaveAttribute("title", /^New chat \(/);
    await page.keyboard.press("Alt+n");
    const menu = page.getByRole("menu", { name: "New chat" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    // Enter on its first choice goes on to New chat's sheet.
    await page.keyboard.press("Alt+n");
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("files dropped anywhere on a chat are attached, and the box says so while they're over it", async ({ page }) => {
    await open(page, "$long");
    await expect(page.locator(".messages").getByText("1,204,331 rows imported")).toBeVisible();
    const drop = (type: string) =>
      page.locator(".messages").evaluate((el, type) => {
        const data = new DataTransfer();
        data.items.add(new File(["dropped on the messages"], "notes.txt", { type: "text/plain" }));
        el.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
      }, type);
    await drop("dragover");
    await expect(page.getByText("Drop files or folders to attach them")).toBeVisible();
    await drop("drop");
    await expect(page.getByText("Drop files or folders to attach them")).toHaveCount(0);
    await expect(page.locator(".composer-file")).toContainText("notes.txt");
  });

  test("an icon-only button says its name under the mouse; one with words on it, or a tooltip of its own, is left as it is", async ({ page }) => {
    await open(page, "$long");
    await page.getByRole("button", { name: "Chat settings" }).click();
    const close = page.getByRole("dialog").getByRole("button", { name: "Close" });
    await expect(close).not.toHaveAttribute("title", /./);
    await close.hover();
    await expect(close).toHaveAttribute("title", "Close");
    // A button with words on it: a section's row.
    const cancel = page.getByRole("dialog").getByRole("button", { name: /^This chat/ });
    await cancel.hover();
    await expect(cancel).not.toHaveAttribute("title", /./);
    await page.keyboard.press("Escape");
    const settings = page.getByRole("button", { name: "Chat settings" });
    await settings.hover();
    await expect(settings).toHaveAttribute("title", "Chat settings");
  });
});

test("Ctrl+K on a phone-wide screen opens the chats drawer with the search ready, and Alt+N its New chat", async ({ page }) => {
  test.skip(project() !== "chromium-390", "A phone's width, with a keyboard");
  await open(page, "$long");
  // No keyboard to speak of: the message box doesn't take the focus by itself.
  await expect(input(page)).not.toBeFocused();
  await page.keyboard.press("Control+k");
  await expect(page.locator(".chat-sidebar.drawer")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Search chats" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".chat-sidebar.drawer")).toHaveCount(0);
  await page.keyboard.press("Alt+n");
  await expect(page.locator(".chat-sidebar.drawer")).toBeVisible();
  await expect(page.getByRole("menu", { name: "New chat" }).getByRole("menuitem").first()).toBeFocused();
});

test.describe("on a touch screen as wide as a computer's", () => {
  test.use({ hasTouch: true });
  test("a chat that opens doesn't take the keyboard, and the search field has no shortcut to say", async ({ page }) => {
    test.skip(project() !== "chromium-1440", "A wide touch screen");
    await open(page, "$long");
    await expect(input(page)).toBeVisible();
    await expect(input(page)).not.toBeFocused();
    await expect(page.locator(".csb-key")).toHaveCount(0);
  });
});

test("held sideways with a cutout at each side: the screen and its top bar reach both edges, and what's in the bar keeps clear", async ({ page }) => {
  // An unfolded phone turned sideways, the chats hidden. The cutout is played by the variables the app reads it into.
  await page.setViewportSize({ width: 960, height: 700 });
  await page.addInitScript(() => localStorage.setItem("crosstalk.sidebar.collapsed", "1"));
  await page.goto("/#/");
  await expect(page.locator(".topbar").first()).toBeVisible();
  await page.addStyleTag({ content: ":root { --safe-left: 48px !important; --safe-right: 48px !important; }" });
  const edges = async (selector: string) => page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right) };
  });
  // Not a column in the middle with a bar of page each side.
  expect(await edges(".topbar")).toEqual({ left: 0, right: 960 });
  const main = await edges(".shell > .main");
  expect(main).toEqual({ left: 48, right: 912 });
  // The bar's first and last buttons stay out from under the cutouts.
  const buttons = page.locator(".topbar button");
  const first = (await buttons.first().boundingBox())!;
  const last = (await buttons.last().boundingBox())!;
  expect(first.x).toBeGreaterThanOrEqual(48);
  expect(last.x + last.width).toBeLessThanOrEqual(912);
  await noHorizontalOverflow(page);
  // With no cutout, the screen is the whole window.
  await page.addStyleTag({ content: ":root { --safe-left: 0px !important; --safe-right: 0px !important; }" });
  expect(await edges(".shell > .main")).toEqual({ left: 0, right: 960 });
});
