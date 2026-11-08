import type { Page, WebSocketRoute } from "@playwright/test";
import type { MachineInfo } from "@crosstalk/shared";
import { test, expect, noHorizontalOverflow } from "./fixtures";
import { otherMachine, pong } from "./otherMachine";

// Machines and devices: pairing, signing a device out, the links between machines (Settings → Machines and the chat
// list's offer to add one). Nothing here touches the test hub's own state: every machine call is answered here.
//
// Each test below says whether it is EXPECTED TO FAIL on 0.6.1, and why. They describe defects found by reading the
// code, not regressions: the comment names the lines that produce the wrong behaviour.

/** A request to the machine this app opens from (the test hub, through the dev server). */
const home = (path: string) => (url: URL) => url.origin === "http://127.0.0.1:5198" && url.pathname === path;
const onPhone = (page: Page) => page.viewportSize()!.width <= 760;
const machinesHeading = (page: Page) => page.getByRole("heading", { name: "Machines", exact: true });

const linkInfo = (url: string, over: Partial<MachineInfo> = {}): MachineInfo => ({
  id: "h_linux",
  name: "Linux box",
  url,
  addedAt: Date.now(),
  scope: "full",
  agents: "one-way",
  error: null,
  introducedBy: null,
  ...over,
});

/** The chat list: the drawer on a phone, docked beside the screen above 760 px. */
async function chats(page: Page) {
  if (onPhone(page)) await page.getByRole("button", { name: /^Show chats/ }).click();
  const list = page.locator("aside.chat-sidebar");
  await expect(list).toBeVisible();
  return list;
}

async function hideChats(page: Page) {
  if (!onPhone(page)) return;
  await page.locator("aside.chat-sidebar.drawer").getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator("aside.chat-sidebar.drawer")).toHaveCount(0);
}

/**
 * EXPECTED TO FAIL. Signing this device out from another one closes its socket with 1008 and the reason "This device
 * has been signed out." (hub/src/server.ts `allowed`), and every later request is a 401. web/src/api.ts drops both:
 * `ws.onclose = () => this.lost(ws)` ignores the close code, and nothing asks over HTTP again while the socket is
 * down (`refresh` runs only on `onStatus("open")`, hubStore.ts start). So the device retries for ever and the strip
 * says "Can't reach Mac mini. Trying again…" and then "Check that Crosstalk is running." — the hub is running, and the
 * only thing that helps is pairing again. The words for it already exist in store.ts (`signedOut`); nothing reaches them.
 */
test("a device signed out from another one says so, instead of blaming the machine", async ({ page }) => {
  let revoked = false;
  const sockets: WebSocketRoute[] = [];
  // Every request of a signed-out device is refused, whatever it asks for: the hub turns its token away before it looks
  // at the route (hub/src/server.ts), so the app may ask anything to find out.
  const homeApi = (url: URL) => url.origin === "http://127.0.0.1:5198" && url.pathname.startsWith("/api/");
  await page.route(homeApi, (route) => (revoked ? route.fulfill({ status: 401, json: { error: "unauthorized" } }) : route.fallback()));
  await page.routeWebSocket("ws://127.0.0.1:5198/api/ws?**", (ws) => {
    sockets.push(ws);
    // A sign-out this device missed: the socket is refused the same way when it tries again.
    if (revoked) return ws.close({ code: 1008, reason: "This device has been signed out." });
    pong(ws);
  });
  await page.goto("/#/");
  await expect(page.getByRole("button", { name: /^(Show chats|New chat)/ }).first()).toBeVisible();
  // Another device: Settings → Devices → Sign out, for this one.
  revoked = true;
  sockets.at(-1)!.close({ code: 1008, reason: "This device has been signed out." });
  await expect(page.getByText(/signed out|no longer paired/i).first()).toBeVisible({ timeout: 10_000 });
  await noHorizontalOverflow(page);
});

/**
 * EXPECTED TO FAIL. MachinesSection.connect (web/src/views/MachinesSection.tsx:67-79) throws away what the hub answers
 * (`Machines.connect` returns the machine with `agents: "connecting"`) and leaves the row's words to `linked`, which is
 * only re-read 2.5 s later. The button is enabled again as soon as the POST returns, so for those 2.5 s the row still
 * reads "Agents: one way · Connect" and the tap looks ignored — and can be made again.
 */
test("Connect says it is connecting as soon as it is tapped", async ({ page, token }) => {
  // Both machines' live connections are played here: a real one through the dev server's ws proxy drops at teardown,
  // and Playwright's own WebSocket stand-in then throws in the page (as machinesSetup.spec.ts does for the same reason).
  await page.routeWebSocket("ws://127.0.0.1:5198/api/ws?**", pong);
  const linux = await otherMachine(page, token, { port: 8491 });
  let tappedAt = 0;
  await page.route(home("/api/machines"), (route) => route.fulfill({ json: [linkInfo(linux.base, { agents: tappedAt ? "connecting" : "one-way" })] }));
  await page.route(home("/api/machines/h_linux/connect"), (route) => {
    tappedAt = Date.now();
    return route.fulfill({ json: linkInfo(linux.base, { agents: "connecting" }) });
  });
  await page.goto("/#/settings/machines");
  await machinesHeading(page).scrollIntoViewIfNeeded();
  const row = page.locator(".machine-row").filter({ hasText: "Linux box" });
  await expect(row).toContainText("Agents: one way");
  const connect = row.getByRole("button", { name: "Connect", exact: true });
  // A finger's height on a phone, as the other text buttons in this list are.
  if (onPhone(page)) expect((await connect.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await connect.click();
  await expect(row).not.toContainText("Agents: one way", { timeout: 1200 });
  await expect(row).toContainText("Agents: connecting…");
});

/**
 * EXPECTED TO FAIL (and slow on purpose: it waits for the hub to give up). After Connect, MachinesSection asks the hub
 * again exactly twice — `setTimeout(loadLinked, 2500)` and `setTimeout(loadLinked, 8000)` — and never again. The hub's
 * own `connectLink` can take about a minute (a 5 s look, then a 60 s pairing call) and then retries after 1, 5, 15 and
 * 60 minutes, so the row sits on "Agents: connecting…" with no words, no reason and no Try again, even though the hub
 * has recorded "failed" with both. Leaving Settings and coming back is the only way to see it.
 */
test("a Connect the machine refuses stops saying connecting", async ({ page, token }) => {
  await page.routeWebSocket("ws://127.0.0.1:5198/api/ws?**", pong);
  const linux = await otherMachine(page, token, { port: 8492 });
  let tappedAt = 0;
  const polls: number[] = [];
  await page.route(home("/api/machines"), (route) => {
    polls.push(Date.now());
    // The hub answers "connecting" while it tries, then "failed" with the reason — here, 9.5 s in: after the second
    // and last poll the screen makes (8 s), with room for that one to arrive late.
    const waited = tappedAt ? Date.now() - tappedAt : 0;
    const agents = !tappedAt ? "one-way" : waited < 9500 ? "connecting" : "failed";
    return route.fulfill({ json: [linkInfo(linux.base, { agents, error: agents === "failed" ? "Couldn't reach linux-box.example.ts.net: connection refused" : null })] });
  });
  await page.route(home("/api/machines/h_linux/connect"), (route) => {
    tappedAt = Date.now();
    return route.fulfill({ json: linkInfo(linux.base, { agents: "connecting" }) });
  });
  await page.goto("/#/settings/machines");
  await machinesHeading(page).scrollIntoViewIfNeeded();
  const row = page.locator(".machine-row").filter({ hasText: "Linux box" });
  await expect(row).toContainText("Agents: one way");
  await row.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(row).toContainText("Agents: couldn't connect: Couldn't reach linux-box.example.ts.net: connection refused", { timeout: 12_000 });
  await expect(row.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  // While it says "connecting…" it has to keep asking: today it asks exactly twice and then stops.
  expect(polls.filter((at) => at > tappedAt).length).toBeGreaterThan(2);
});

/**
 * EXPECTED TO FAIL. Every action in MachinesSection answers a failure with `toast("error", message(e))` and nothing
 * else (lines 74-77, 131-134, 168-172): `loadLinked()` is never called again. So when the machine is already gone —
 * another device or another tab unlinked it, and the hub answers 404 "That machine isn't linked with this one"
 * (hub/src/machines.ts:633) — the row stays on screen with Add and Unlink still on it, and the toast says what
 * happened but not what to do about it. Leaving Settings and coming back is the only way to clear it.
 */
test("a machine unlinked on another device leaves this screen", async ({ page }) => {
  let linked: MachineInfo[] = [linkInfo("https://linux-box.example.ts.net")];
  page.on("dialog", (d) => void d.accept());
  await page.route(home("/api/machines"), (route) => route.fulfill({ json: linked }));
  await page.route(home("/api/machines/h_linux"), (route) => {
    // Another device got there first.
    linked = [];
    return route.fulfill({ status: 404, json: { error: "That machine isn't linked with this one" } });
  });
  await page.goto("/#/settings/machines");
  await machinesHeading(page).scrollIntoViewIfNeeded();
  const row = page.locator(".machine-row").filter({ hasText: "Linux box" });
  await expect(row).toContainText("Not on this device yet");
  await row.getByRole("button", { name: "Unlink", exact: true }).click();
  await expect(page.locator(".toast").filter({ hasText: "isn't linked" })).toBeVisible();
  await expect(row).toHaveCount(0, { timeout: 5_000 });
});

/**
 * EXPECTED TO FAIL. The chat list's offer to add a machine linked elsewhere comes from `useLinked`
 * (web/src/views/ChatSidebar.tsx:58-84): a module-level cache kept five minutes, whose effect depends only on
 * `[key, open]`. Unlinking the machine in Settings → Machines never clears it, so the list keeps offering
 * "Linux box was linked · Add it here" — five minutes on a phone (the drawer is built again each time it opens), and
 * until the hub reconnects or the page is reloaded where the list is docked. Tapping it lands on Settings → Machines,
 * where the machine isn't.
 */
test("the chat list stops offering a machine that was just unlinked", async ({ page }) => {
  let linked: MachineInfo[] = [linkInfo("https://linux-box.example.ts.net")];
  page.on("dialog", (d) => void d.accept());
  await page.route(home("/api/machines"), (route) => route.fulfill({ json: linked }));
  await page.route(home("/api/machines/h_linux"), (route) => {
    linked = [];
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/#/settings/machines");
  const offer = (await chats(page)).locator(".csb-machine").filter({ hasText: "Linux box was linked" });
  await expect(offer).toBeVisible();
  expect((await offer.getByRole("button", { name: "Add it here", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(onPhone(page) ? 44 : 1);
  await hideChats(page);
  const row = page.locator(".machine-row").filter({ hasText: "Linux box" });
  await row.scrollIntoViewIfNeeded();
  await row.getByRole("button", { name: "Unlink", exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect((await chats(page)).locator(".csb-machine").filter({ hasText: "Linux box was linked" })).toHaveCount(0);
});

/**
 * EXPECTED TO FAIL. PairDialog (web/src/views/DevicesPage.tsx:242-288) shows the code, the QR and "expires at …" and
 * then never looks at the clock again. A pairing code lasts 30 minutes (hub/src/auth.ts PAIRING_TTL_MS); the screen a
 * person leaves open while walking to the other device goes on offering a code the hub will refuse, and the only
 * explanation they get is "That code is wrong or expired" on the new device.
 */
test("the pairing dialog says when its code has run out", async ({ page }) => {
  await page.route(home("/api/pairing-codes"), (route) => route.fulfill({ json: { code: "ABCD-EFGH", expiresAt: Date.now() + 2500, url: null } }));
  await page.goto("/#/settings/devices");
  await page.getByRole("button", { name: "Pair a new device", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Pair a device", exact: true });
  await expect(dialog.locator(".code-big")).toHaveText("ABCD-EFGH");
  await noHorizontalOverflow(page);
  await expect(dialog).toContainText(/expired|ran out|no longer works|make a new/i, { timeout: 8_000 });
});
