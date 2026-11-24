import { test, expect, noHorizontalOverflow } from "./fixtures";
import { join } from "node:path";

// Screen (ScreenPage.tsx, hub/src/screen): the machine's screen in the app. The "machine's screen" here is the test
// hub's own small screen-sharing server (e2e/hub.ts), 640 × 400 with a light rectangle on blue: the page signs in to it
// through the hub, draws it, zooms to a window, and in Control sends taps and typing. Port 8452 says what it was sent.

const HUB = "http://127.0.0.1:8451";
const SCREEN = "http://127.0.0.1:8452";
const shot = (name: string) => (process.env.CT_SHOTS ? { path: join(process.env.CT_SHOTS, name) } : {});
const project = () => test.info().project.name;
const onPhones = () => test.skip(!/-(320|390)$/.test(project()), "Phone widths: the 320 and 390 projects.");
const events = async () => (await (await fetch(`${SCREEN}/events`)).json()) as { events: ({ t: "pointer"; x: number; y: number; buttons: number } | { t: "key"; sym: number; down: boolean })[]; clients: number };

test("the screen is set up with its password, shown live, zoomed to an agent's window, and driven once control is taken", async ({ page, request, token }) => {
  onPhones();
  // A phone: it opens in Watch, where a finger moves the view (the test's browser has a mouse, which would open in
  // Control: this is a device that was left in Watch).
  await page.addInitScript(() => {
    if (!localStorage.getItem("crosstalk.screen.control.v1")) localStorage.setItem("crosstalk.screen.control.v1", "0");
  });
  const width = page.viewportSize()!.width;
  await page.setViewportSize({ width, height: 844 });
  const headers = { authorization: `Bearer ${token}` };
  // The windows the hub would list on a Mac: one of an agent's, one not.
  await page.route("**/api/screen/windows", (r) =>
    r.fulfill({ json: { windows: [{ id: 7, app: "Finder", title: "", x: 300, y: 200, width: 300, height: 180, agent: false }, { id: 9, app: "BrowserOS neo", title: "Shop", x: 40, y: 30, width: 200, height: 120, agent: true }] } }),
  );
  try {
    // Not set up yet: the sidebar offers Screen, and the page says what to do and takes the password.
    await page.goto("/");
    const show = page.getByRole("button", { name: "Show chats", exact: true });
    if (await show.count()) await show.click();
    const side = page.getByRole("complementary", { name: "Chats", exact: true });
    const link = side.getByRole("button", { name: "Screen", exact: true });
    const bookmarks = side.getByRole("button", { name: "Bookmarks", exact: true });
    await expect(link).toBeVisible();
    // (First in the row under the list, before Bookmarks.)
    expect((await link.boundingBox())!.x).toBeLessThan((await bookmarks.boundingBox())!.x);
    await link.click();
    await expect(page.getByRole("heading", { name: "Screen", exact: true })).toBeVisible();
    const setup = page.getByRole("region", { name: /Give Crosstalk .* screen sharing password/ });
    await expect(setup).toBeVisible();
    await expect(setup).toContainText("Kept on");
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot(`screen-setup-${width}.png`), animations: "disabled" });

    // A wrong password says so; the right one brings the screen up.
    const field = setup.getByRole("textbox", { name: /^Screen sharing password/ });
    await field.fill("nope");
    await setup.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByRole("region", { name: "That password didn't work", exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: /^Screen sharing password/ }).fill("screen-pw");
    await page.getByRole("button", { name: "Connect", exact: true }).click();

    const view = page.locator(".screen-view");
    await expect(view).toBeVisible();
    const canvas = view.locator("canvas");
    await expect(canvas).toBeVisible();
    await expect(page.getByText("Connecting to the screen…")).toHaveCount(0);
    // What the fake screen painted is what's drawn: blue, with the light rectangle at 40,30.
    const colour = (x: number, y: number) =>
      canvas.evaluate((c: HTMLCanvasElement, [px, py]) => [...c.getContext("2d")!.getImageData(px!, py!, 1, 1).data.slice(0, 3)], [x, y]);
    await expect.poll(() => colour(400, 300)).toEqual([20, 60, 140]);
    expect(await colour(100, 80)).toEqual([240, 240, 240]);
    // The whole screen fits the view's width to start with.
    const fit = (await view.boundingBox())!.width / 640;
    expect((await canvas.boundingBox())!.width).toBeCloseTo(640 * fit, 0);
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot(`screen-live-${width}.png`), animations: "disabled" });

    // Windows: the agent's first. Its button zooms the view to it.
    const windows = page.getByRole("group", { name: "Go to a window", exact: true });
    await expect(windows.getByRole("button")).toHaveText(["Whole screen", "BrowserOS neo: Shop", "Finder"]);
    await windows.getByRole("button", { name: "BrowserOS neo: Shop", exact: true }).click();
    await expect(windows.getByRole("button", { name: "BrowserOS neo: Shop", exact: true })).toHaveAttribute("aria-pressed", "true");
    const zoomed = Math.min(2, (await view.boundingBox())!.width / 200);
    await expect.poll(async () => Math.round((await canvas.boundingBox())!.width)).toBe(Math.round(640 * zoomed));
    // Scrolled to the window's corner, or as far as the screen goes (a view taller than what's left can't go further).
    await expect
      .poll(() =>
        view.evaluate((el, [left, top]) => {
          const wantLeft = Math.min(left!, el.scrollWidth - el.clientWidth), wantTop = Math.min(top!, el.scrollHeight - el.clientHeight);
          return Math.abs(el.scrollLeft - wantLeft) <= 1 && Math.abs(el.scrollTop - wantTop) <= 1;
        }, [40 * zoomed, 30 * zoomed]),
      )
      .toBe(true);
    await page.screenshot({ ...shot(`screen-window-${width}.png`), animations: "disabled" });

    // Watching sends nothing. Taking control makes a tap a click, where the finger is on the screen.
    await events();
    const box = (await canvas.boundingBox())!;
    const vbox = (await view.boundingBox())!;
    const tapAt = { x: vbox.x + vbox.width / 2, y: vbox.y + 60 };
    await page.mouse.click(tapAt.x, tapAt.y);
    await page.waitForTimeout(300);
    expect((await events()).events.filter((e) => e.t === "pointer" && e.buttons)).toEqual([]);
    await page.getByRole("button", { name: "Control", exact: true }).click();
    // Taking control doesn't move the picture.
    expect((await canvas.boundingBox())!.y).toBe(box.y);
    await page.mouse.click(tapAt.x, tapAt.y);
    const want = { x: Math.round((tapAt.x - box.x) / zoomed), y: Math.round((tapAt.y - box.y) / zoomed) };
    // Each look takes what was sent since the last one: keep them all.
    const presses: { x: number; y: number }[] = [];
    await expect
      .poll(async () => {
        for (const e of (await events()).events) if (e.t === "pointer" && e.buttons === 1) presses.push({ x: e.x, y: e.y });
        return presses.length;
      })
      .toBe(1);
    expect(Math.abs(presses[0]!.x - want.x), `pressed at ${JSON.stringify(presses[0])}, wanted ${JSON.stringify(want)}`).toBeLessThanOrEqual(2);
    expect(Math.abs(presses[0]!.y - want.y), `pressed at ${JSON.stringify(presses[0])}, wanted ${JSON.stringify(want)}`).toBeLessThanOrEqual(2);

    // The keyboard: typed text goes as keys, with Shift for the capital; Return is its own button.
    await page.getByRole("button", { name: "Keyboard", exact: true }).click();
    await page.getByLabel(/^Type on /).fill("Hi");
    await page.getByRole("button", { name: "Type", exact: true }).click();
    await page.getByRole("button", { name: "Return", exact: true }).click();
    const typed: string[] = [];
    await expect
      .poll(async () => {
        for (const e of (await events()).events) if (e.t === "key") typed.push(`${e.down ? "+" : "-"}${e.sym.toString(16)}`);
        return typed;
      })
      .toEqual(["+ffe1", "+48", "-48", "-ffe1", "+69", "-69", "+ff0d", "-ff0d"]);
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot(`screen-control-${width}.png`), animations: "disabled" });

    // What changes on the screen shows up by itself.
    await fetch(`${SCREEN}/paint`, { method: "POST", body: JSON.stringify({ x: 0, y: 0, w: 640, h: 400, rgb: [200, 30, 30] }) });
    await expect.poll(() => colour(400, 300)).toEqual([200, 30, 30]);

    // Options: agents are off until turned on, and the hub says so.
    await page.getByRole("button", { name: "Options", exact: true }).click();
    const agents = page.getByRole("checkbox", { name: "Let agents use this screen", exact: true });
    await expect(agents).not.toBeChecked();
    // Saved on the machine first, then shown: a tap, not a check that expects the box to flip at once.
    await agents.click();
    await expect(agents).toBeChecked();
    await expect.poll(async () => (await (await request.get(`${HUB}/api/screen`, { headers })).json()).agents).toBe(true);
  } finally {
    await fetch(`${SCREEN}/paint`, { method: "POST", body: JSON.stringify({ x: 0, y: 0, w: 640, h: 400, rgb: [20, 60, 140] }) });
    await fetch(`${SCREEN}/paint`, { method: "POST", body: JSON.stringify({ x: 40, y: 30, w: 200, h: 120, rgb: [240, 240, 240] }) });
    await request.put(`${HUB}/api/screen`, { headers, data: { password: null, agents: false, username: "" } });
  }
});

test("with a mouse it opens in Control: the keyboard is the screen's at once and stays so, and Watch says how to take control back", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  await page.route("**/api/screen/windows", (r) => r.fulfill({ json: { windows: [{ id: 9, app: "BrowserOS neo", title: "Shop", x: 40, y: 30, width: 200, height: 120, agent: true }] } }));
  const keys = async () => (await events()).events.filter((e) => e.t === "key").map((e) => (e.t === "key" ? `${e.down ? "+" : "-"}${e.sym.toString(16)}` : ""));
  const typed: string[] = [];
  const arrives = (want: string[]) => expect.poll(async () => (typed.push(...(await keys())), typed.slice(-want.length))).toEqual(want);
  try {
    expect((await request.put(`${HUB}/api/screen`, { headers, data: { password: "screen-pw", username: "" } })).ok()).toBe(true);
    await page.goto("/#/screen");
    const control = page.getByRole("button", { name: "Control", exact: true });
    await expect(control).toHaveAttribute("aria-pressed", "true");
    const view = page.locator(".screen-view");
    await expect(view.locator("canvas")).toBeVisible();
    await expect(page.getByText("Connecting to the screen…")).toHaveCount(0);
    await events();

    // No click first: what's typed goes to the screen.
    await page.keyboard.press("a");
    await arrives(["+61", "-61"]);
    // A button of the page (a window, zoom) doesn't take the keyboard away.
    await page.getByRole("button", { name: /^BrowserOS neo/ }).click();
    await page.keyboard.press("b");
    await arrives(["+62", "-62"]);
    await page.getByRole("button", { name: "Whole screen", exact: true }).click();
    await page.keyboard.press("Enter");
    await arrives(["+ff0d", "-ff0d"]);
    // The whole screen is all in view: as wide and as tall as fits, never scrolling.
    const fits = await view.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1);
    expect(fits).toBe(true);

    // Watch: nothing is sent, and a key or a click meant for the screen says how to take control.
    await page.getByRole("button", { name: "Watch", exact: true }).click();
    await events();
    await page.keyboard.press("c");
    const nudge = page.getByRole("status").filter({ hasText: "You're only watching." });
    await expect(nudge).toBeVisible();
    await page.waitForTimeout(250);
    expect(await keys()).toEqual([]);
    await nudge.getByRole("button", { name: "Take control", exact: true }).click();
    await expect(control).toHaveAttribute("aria-pressed", "true");
    await expect(nudge).toHaveCount(0);
    await page.keyboard.press("d");
    await arrives(["+64", "-64"]);

    // Left in Watch, it opens in Watch next time on this device.
    await page.getByRole("button", { name: "Watch", exact: true }).click();
    await page.reload();
    await expect(page.getByRole("button", { name: "Watch", exact: true })).toHaveAttribute("aria-pressed", "true");
    await noHorizontalOverflow(page);
  } finally {
    await request.put(`${HUB}/api/screen`, { headers, data: { password: null, agents: false, username: "" } });
  }
});

test("a Mac's own Screen Sharing: signed in to as the Mac's account, and a login screen macOS made aside is said with the way to the desktop", async ({ page, request, token }) => {
  const headers = { authorization: `Bearer ${token}` };
  const width = page.viewportSize()!.width;
  // What a hub on a Mac says: the account it runs as, and what the last sign-in got.
  let now: Record<string, unknown> = { platform: "darwin", hasPassword: false, username: "", account: "sam", separate: false, agents: false, ready: false, state: "auth", problem: "Screen sharing wants a password, and Crosstalk hasn't been given one yet.", width: 0, height: 0, viewers: 0 };
  const sent: Record<string, unknown>[] = [];
  await page.route("**/api/screen/windows", (r) => r.fulfill({ json: { windows: [] } }));
  await page.route("**/api/screen/check", (r) => r.fulfill({ json: now }));
  await page.route("**/api/screen", async (r) => {
    if (r.request().method() === "PUT") {
      const body = r.request().postDataJSON() as Record<string, unknown>;
      sent.push(body);
      // The screen sharing password alone gets a login screen of macOS's making; the Mac's account gets the desktop.
      now = { ...now, hasPassword: true, ready: true, state: "ready", problem: null, width: 640, height: 400, username: body.username ?? "", separate: !body.username };
    }
    await r.fulfill({ json: now });
  });
  try {
    // The picture itself comes from the test hub's screen.
    expect((await request.put(`${HUB}/api/screen`, { headers, data: { password: "screen-pw", username: "" } })).ok()).toBe(true);
    await page.goto("/#/screen");
    const setup = page.getByRole("region", { name: /^Sign in to see .* screen$/ });
    await expect(setup).toBeVisible();
    // One field: the account is the one whose desktop is on the Mac's screen, filled in.
    await expect(setup.getByRole("textbox", { name: /^Password for sam on / })).toBeVisible();
    await expect(setup.getByRole("textbox", { name: "Mac account name", exact: true })).toHaveCount(0);
    await expect(setup).toContainText("you get the desktop that's on its screen");
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot(`screen-mac-setup-${width}.png`), animations: "disabled" });
    // Another account can be named.
    await setup.getByRole("button", { name: "Use another account", exact: true }).click();
    await expect(setup.getByRole("textbox", { name: "Mac account name", exact: true })).toHaveValue("sam");

    // The other way in, a screen sharing password: macOS shows it a login screen of its own, and the page says so.
    await setup.getByRole("button", { name: "Use a screen sharing password", exact: true }).click();
    await expect(setup).toContainText("a login screen of its own");
    await setup.getByRole("textbox", { name: /^Screen sharing password/ }).fill("vnc-only");
    await setup.getByRole("button", { name: "Connect", exact: true }).click();
    expect(sent.at(-1)).toEqual({ password: "vnc-only", username: "" });
    const aside = page.getByRole("alert", { name: "This isn't the desktop", exact: true });
    await expect(aside).toContainText("This is a login screen macOS made for Crosstalk");
    await expect(aside).toContainText("Sign in as sam");
    await expect(page.locator(".screen-view canvas")).toBeVisible();
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot(`screen-mac-aside-${width}.png`), animations: "disabled" });

    // Signed in as the account, right there: the note goes, and the view connects afresh.
    await aside.getByRole("textbox", { name: /^Password for sam on / }).fill("the mac password");
    await aside.getByRole("button", { name: "Connect", exact: true }).click();
    expect(sent.at(-1)).toEqual({ password: "the mac password", username: "sam" });
    await expect(aside).toHaveCount(0);
    await expect(page.locator(".screen-view canvas")).toBeVisible();
    await expect(page.getByText("Connecting to the screen…")).toHaveCount(0);
  } finally {
    await request.put(`${HUB}/api/screen`, { headers, data: { password: null, agents: false, username: "" } });
  }
});
