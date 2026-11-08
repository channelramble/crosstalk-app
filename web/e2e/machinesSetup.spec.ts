import type { Page, Route } from "@playwright/test";
import type { MachineInfo, StorageItem, StorageReport } from "@crosstalk/shared";
import { test, expect, noHorizontalOverflow, settingsTab } from "./fixtures";
import { otherMachine, pong } from "./otherMachine";

const HUB = "http://127.0.0.1:8451";
// CT_SHOTS: a folder to save the phone screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: `${process.env.CT_SHOTS}/${name}` } : {});
const phone = (page: Page) => page.setViewportSize({ width: 390, height: 844 });
/** The machine this app opens from (the test hub), as requests to it are addressed. */
const home = (path: string) => (url: URL) => url.origin === "http://127.0.0.1:5198" && url.pathname === path;
const machines = (page: Page) => page.getByRole("heading", { name: "Machines", exact: true });

async function homeName(page: Page, token: string): Promise<string> {
  return (await (await page.request.get(`${HUB}/api/state`, { headers: { authorization: `Bearer ${token}` } })).json()).hub.name;
}

/** The Linux setup command's side on the hub: each new command, and how its machine's tries went. */
async function setupCommands(page: Page) {
  const made: string[] = [];
  const status = new Map<string, { status: string; error?: string; machine?: MachineInfo }>();
  await page.route(home("/api/machines/invite"), (route) => {
    const token = `tok${made.length + 1}`;
    made.push(token);
    status.set(token, { status: "waiting" });
    return route.fulfill({ json: { token, command: `curl -fsSL 'https://mac-mini.example.ts.net/api/machines/install/${token}' | bash`, expiresAt: Date.now() + 3600_000 } });
  });
  await page.route("**/api/machines/invites/*", (route) => route.fulfill({ json: status.get(new URL(route.request().url()).pathname.split("/").pop()!) ?? { status: "expired" } }));
  return { made, status };
}

test("a failed link shows its reason, and after three failures Make a new command starts over", async ({ page }) => {
  await phone(page);
  const setup = await setupCommands(page);
  await page.goto("/#/settings/machines");
  await machines(page).scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Set up a Linux machine", exact: true }).click();
  await expect(page.locator(".command-box code")).toHaveText(/^curl -fsSL 'https:\/\/mac-mini\.example\.ts\.net\/api\/machines\/install\/tok\d' \| bash$/);
  const first = /tok\d/.exec((await page.locator(".command-box code").textContent())!)![0];
  await expect(page.getByText("Waiting for the machine… (the command works for an hour)", { exact: true })).toBeVisible();
  // A try failed: while it waits, it says why and what to do.
  setup.status.set(first, { status: "waiting", error: "The machine must be on the same Tailscale network." });
  const lastTry = page.getByRole("alert").filter({ hasText: "Last try failed" });
  await expect(lastTry).toHaveText("Last try failed: The machine must be on the same Tailscale network. Fix that and run the same command again.");
  await lastTry.scrollIntoViewIfNeeded();
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("linux-setup-last-try.png"), animations: "disabled" });
  // Three failures use the command up: it says so, and a new one is a tap away.
  setup.status.set(first, { status: "failed", error: "The machine must be on the same Tailscale network." });
  const over = page.getByRole("alert").filter({ hasText: "Linking failed 3 times" });
  await expect(over).toContainText("Linking failed 3 times: The machine must be on the same Tailscale network. Fix that first: this command doesn't work any more.");
  await expect(page.locator(".command-box")).toHaveCount(0);
  // Step 2 says what to do now, with the button where the command was.
  const step = page.locator(".setup-steps > li").nth(1);
  await expect(step).toContainText("Tap Make a new command, then run it in a terminal there:");
  await expect(step.getByRole("button", { name: "Make a new command", exact: true })).toBeVisible();
  await over.scrollIntoViewIfNeeded();
  await page.screenshot({ ...shot("linux-setup-failed.png"), animations: "disabled" });
  const before = setup.made.length;
  await over.getByRole("button", { name: "Make a new command", exact: true }).click();
  await expect.poll(() => setup.made.length).toBe(before + 1);
  const second = setup.made.at(-1)!;
  await expect(page.locator(".command-box code")).toHaveText(`curl -fsSL 'https://mac-mini.example.ts.net/api/machines/install/${second}' | bash`);
  await expect(page.getByRole("alert").filter({ hasText: "Linking failed" })).toHaveCount(0);
  // And it waits for the new one.
  setup.status.set(second, { status: "waiting", error: "Couldn't reach linux-box.example.ts.net: connection refused" });
  await expect(page.getByRole("alert").filter({ hasText: "Last try failed" })).toContainText("Couldn't reach linux-box.example.ts.net: connection refused.");
});

/**
 * A Linux box that isn't on this device yet, played here: it pairs this device, then answers as a hub with Codex
 * signed in and Claude Code not.
 */
async function newLinuxBox(page: Page, port: number) {
  const base = `http://127.0.0.1:${port}`;
  const cors = { "access-control-allow-origin": "http://127.0.0.1:5198", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS" };
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify(body) });
  const at = Date.now();
  const hub = { version: "test", hostname: "linux-box", platform: "linux", workspaceRoot: "/home/me/Crosstalk", publicUrl: null, id: "h_linux", name: "Linux box" };
  const status = (provider: string, signedIn: boolean) => ({ provider, installed: true, version: "test", binPath: null, signedIn, account: signedIn ? "me@linux" : null, plan: null, authMethod: null, error: null, checkedAt: at });
  await page.route(`${base}/**`, (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (path === "/api/pair") return json(route, { token: "linux-box-token", device: { id: "d_phone" }, hub });
    if (path === "/api/state") {
      return json(route, {
        hub,
        rooms: [],
        members: [],
        approvals: [],
        usage: [],
        roomActivity: {},
        device: { id: "d_phone", name: "Browser tests", platform: "Web", createdAt: at, lastSeenAt: at },
        providers: [status("claude", false), status("codex", true)],
        accounts: [
          { ...status("claude", false), id: "default", label: "Main", kind: "signin" },
          { ...status("codex", true), id: "default", label: "Main", kind: "signin" },
        ],
      });
    }
    if (path.startsWith("/api/providers/")) return json(route, { provider: path.split("/")[3], live: true, error: null, models: [] });
    return json(route, { error: "not found" }, 404);
  });
  await page.routeWebSocket(`${base.replace("http", "ws")}/api/ws?**`, pong);
  const info: MachineInfo = { id: "h_linux", name: "Linux box", url: base, addedAt: at, scope: "full", agents: "one-way", error: null, introducedBy: null };
  return { base, info };
}

test("a machine just added says what's next there, and Sign in opens its agent card", async ({ page }) => {
  await phone(page);
  await page.routeWebSocket("ws://127.0.0.1:5198/api/ws?**", pong);
  const linux = await newLinuxBox(page, 8453);
  const setup = await setupCommands(page);
  let linked: MachineInfo[] = [];
  await page.route(home("/api/machines"), (route) => route.fulfill({ json: linked }));
  await page.route(home("/api/machines/h_linux/pair-code"), (route) => route.fulfill({ json: { url: linux.base, code: "ABCD-EFGH" } }));
  await page.goto("/#/settings/machines");
  await machines(page).scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Set up a Linux machine", exact: true }).click();
  await expect(page.locator(".command-box code")).toBeVisible();
  const token = /tok\d/.exec((await page.locator(".command-box code").textContent())!)![0];
  // The command ran there and linked it.
  linked = [linux.info];
  setup.status.set(token, { status: "done", machine: linux.info });
  const next = page.getByRole("region", { name: "Next on Linux box", exact: true });
  await expect(next).toContainText("Linux box is added: its chats show in the sidebar. Sign Claude Code in there to chat with it.");
  await expect(next.getByText("Codex is ready", { exact: true })).toBeVisible();
  const signIn = next.getByRole("button", { name: "Sign in Claude Code", exact: true });
  await expect(signIn).toBeEnabled();
  await next.scrollIntoViewIfNeeded();
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("next-on-linux-box.png"), animations: "disabled" });
  // It switches to that machine and opens Claude Code's card there.
  await signIn.click();
  await expect(page.getByRole("combobox", { name: "Machine", exact: true })).toHaveValue(linux.base);
  await expect(page.locator(".topbar .sub")).toHaveText("Linux box");
  const card = page.locator("#agent-claude");
  await expect(card).toContainText("Not signed in");
  await expect(card).toBeInViewport();
  await page.waitForTimeout(600);
  await expect(card).toBeInViewport();
  await page.screenshot({ ...shot("next-sign-in-opens-card.png"), animations: "disabled" });
});

test("machine rows wrap at 390 px, and machine links in Devices point to Machines", async ({ page, token }) => {
  await phone(page);
  await page.routeWebSocket("ws://127.0.0.1:5198/api/ws?**", pong);
  const linux = await otherMachine(page, token, { port: 8454 });
  await page.route(home("/api/computers"), (route) => route.fulfill({ json: [{ name: "macbook", label: "Ana's MacBook Pro with the iPhone", user: "ana", host: "100.64.0.9", online: false, detail: "Asleep" }] }));
  await page.route(home("/api/devices"), async (route) => {
    const list = await (await route.fetch()).json();
    return route.fulfill({ json: [...list, { id: "d_linkfixture", name: "Linux box (hub)", platform: "Crosstalk hub", createdAt: Date.now() - 86_400_000, lastSeenAt: Date.now(), scope: "peer", hubId: "h_linux" }] });
  });
  await page.goto("/#/settings/machines");
  await machines(page).scrollIntoViewIfNeeded();
  const rows = page.locator(".machine-row");
  await expect(rows).toHaveCount(3);
  for (const name of [await homeName(page, token), "Linux box", "Ana's MacBook Pro with the iPhone"]) {
    const title = rows.filter({ hasText: name }).locator(".title");
    await expect(title).toContainText(name);
    // Shown whole, not cut to "Linu…".
    expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth && getComputedStyle(el).textOverflow !== "ellipsis")).toBe(true);
  }
  // The buttons went under the name, not over it.
  const box = rows.filter({ hasText: "Linux box" });
  const [text, actions] = await Promise.all([box.locator(".row-text").boundingBox(), box.locator(".row-actions").boundingBox()]);
  expect(actions!.y).toBeGreaterThanOrEqual(text!.y + text!.height - 1);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("machine-rows-wrap.png"), animations: "disabled" });
  // Another machine's sign-in here is that link's: managed from Machines, not signed out from the Devices tab's list.
  await settingsTab(page, "Devices");
  const link = page.locator(".list-row").filter({ hasText: "Linux box (hub)" });
  expect(await link.locator(".title").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(link.locator(".subtitle")).toContainText("Machine link (agents only)");
  await expect(link.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
  // A finger's height on a phone, though it reads as a link.
  expect((await link.getByRole("button", { name: "Managed in Machines", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await link.scrollIntoViewIfNeeded();
  await page.screenshot({ ...shot("devices-machine-link.png"), animations: "disabled" });
  // It takes you to Machines, in its own tab.
  await link.getByRole("button", { name: "Managed in Machines", exact: true }).click();
  await expect(machines(page)).toBeInViewport();
  void linux;
});

test("a link the other machine stopped accepting gets Link again, with a code from it", async ({ page, token }) => {
  await phone(page);
  await page.routeWebSocket("ws://127.0.0.1:5198/api/ws?**", pong);
  const linux = await otherMachine(page, token, { port: 8455 });
  let agents = "signed-out";
  await page.route(home("/api/machines"), (route) => route.fulfill({ json: [{ id: "h_linux", name: "Linux box", url: linux.base, addedAt: Date.now(), scope: "full", agents, error: "This machine no longer accepts this hub's sign-in: link it again.", introducedBy: null }] }));
  // This device is paired with the Linux box, so it gets a code from it…
  const cors = { "access-control-allow-origin": "http://127.0.0.1:5198", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
  await page.route(`${linux.base}/api/pairing-codes`, (route) => (route.request().method() === "OPTIONS" ? route.fulfill({ status: 204, headers: cors }) : route.fulfill({ headers: cors, json: { code: "WXYZ-2345", expiresAt: Date.now() + 600_000, url: null } })));
  // …and the machine this app opens from links it again with that code.
  const relinked: unknown[] = [];
  await page.route(home("/api/machines/link"), (route) => {
    relinked.push(route.request().postDataJSON());
    agents = "one-way";
    return route.fulfill({ json: { id: "h_linux", name: "Linux box", url: linux.base, addedAt: Date.now(), scope: "full", agents: "one-way" } });
  });
  await page.goto("/#/settings/machines");
  const row = page.locator(".machine-row").filter({ hasText: "Linux box" });
  await row.scrollIntoViewIfNeeded();
  await expect(row).toContainText(`It no longer accepts ${await homeName(page, token)}'s sign-in · Link again`);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("machine-link-again.png"), animations: "disabled" });
  expect((await row.getByRole("button", { name: "Link again", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await row.getByRole("button", { name: "Link again", exact: true }).click();
  await expect(page.getByText("Linux box is linked again.", { exact: true })).toBeVisible();
  expect(relinked).toEqual([{ url: linux.base, code: "WXYZ-2345" }]);
  await expect(row.getByRole("button", { name: "Link again", exact: true })).toHaveCount(0);
});

test("linked machines that couldn't be checked say so, with Retry", async ({ page, token }) => {
  await phone(page);
  let fail = true;
  await page.route(home("/api/machines"), (route) => (fail ? route.fulfill({ status: 503, json: { error: "The hub is restarting." } }) : route.fulfill({ json: [{ id: "h_linux", name: "Linux box", url: "https://linux-box.example.ts.net", addedAt: Date.now(), scope: "full", agents: "one-way", error: null, introducedBy: null }] })));
  await page.goto("/#/settings/machines");
  const failed = page.getByRole("alert").filter({ hasText: "Couldn't check which machines" });
  await expect(failed).toHaveText(`Couldn't check which machines ${await homeName(page, token)} links: The hub is restarting.Retry`);
  fail = false;
  await failed.getByRole("button", { name: "Retry", exact: true }).click();
  // The one not on this device yet shows up, with Add.
  const row = page.locator(".machine-row").filter({ hasText: "Linux box" });
  await expect(row).toContainText("Not on this device yet · linux-box.example.ts.net");
  await expect(failed).toHaveCount(0);
});

test("Remove on the home machine asks twice", async ({ page, token }) => {
  await phone(page);
  await page.routeWebSocket("ws://127.0.0.1:5198/api/ws?**", pong);
  await otherMachine(page, token, { port: 8456 });
  const name = await homeName(page, token);
  await page.goto("/#/settings/machines");
  const row = page.locator(".machine-row").filter({ hasText: name });
  await row.scrollIntoViewIfNeeded();
  await row.getByRole("button", { name: "Remove", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Remove ${name} from this device?`, exact: true });
  await expect(dialog).toContainText(`This app opens from ${name}. Its chats stay on it, but this device stops showing them, and stops getting notifications: they come through ${name}.`);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("remove-home-step-1.png"), animations: "disabled" });
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  const sure = page.getByRole("dialog", { name: "Are you sure?", exact: true });
  // How to get it back, before it goes.
  await expect(sure).toContainText(`To get ${name} back, you'll need a pairing code from it: on a device that still has it, Settings → Pair a new device. Then here, Settings → Machines → Add a machine that runs Crosstalk, with its address: 127.0.0.1:5198.`);
  await page.screenshot({ ...shot("remove-home-step-2.png"), animations: "disabled" });
  // Cancel at the second step keeps it.
  await sure.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(sure).toHaveCount(0);
  await expect(row).toBeVisible();
  // Both steps: it goes from this device.
  await row.getByRole("button", { name: "Remove", exact: true }).click();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await sure.getByRole("button", { name: "Yes, remove", exact: true }).click();
  await expect(page.locator(".machine-row").filter({ hasText: name })).toHaveCount(0);
  await expect(page.locator(".machine-row").filter({ hasText: "Linux box" })).toBeVisible();
});

test("Storage delete names Check first items and asks twice", async ({ page }) => {
  await phone(page);
  const at = Date.now();
  const item = (id: string, kind: StorageItem["kind"], name: string, gb: number): StorageItem => ({ id, kind, name, path: `/work/app/${name}`, bytes: gb * 1024 ** 3, modifiedAt: at, chats: ["Fix login"], chatActiveAt: at - 86_400_000, note: kind === "build" ? "Made again by the next build." : "Check it before deleting." });
  const items = [item("i1", "build", "node_modules", 1.2), item("i2", "large", "render.mov", 3), item("i3", "upload", "photos.zip", 0.5)];
  let report: StorageReport = { status: { total: 500 * 1024 ** 3, free: 40 * 1024 ** 3, reserve: 2 * 1024 ** 3, low: false }, scannedAt: at, busy: null, lastDelete: null, chats: [], items, trash: null, caches: [], cleared: [] };
  const deletes: unknown[] = [];
  await page.route("**/api/storage", (route) => route.fulfill({ json: report }));
  await page.route("**/api/storage/delete", (route) => {
    deletes.push(route.request().postDataJSON());
    report = { ...report, items: [], lastDelete: { at: Date.now(), removed: 3, bytes: items.reduce((n, i) => n + i.bytes, 0), failed: [] } };
    return route.fulfill({ json: report });
  });
  await page.goto("/#/settings/storage");
  const list = page.locator(".storage-item");
  await expect(list).toHaveCount(3);
  for (const i of items) await list.filter({ hasText: i.name }).locator("input[type=checkbox]").check();
  await page.getByRole("button", { name: /^Delete 3 / }).click();
  const dialog = page.getByRole("dialog", { name: "Delete 3 items (4.7 GB)?", exact: true });
  // What nothing makes again is named, each one; the build folder is said to come back.
  await expect(dialog.locator(".delete-list li")).toHaveText(["render.mov · 3.0 GB · in Fix login · Check first", "photos.zip · 512 MB · in Fix login · Sent by you"]);
  await expect(dialog).toContainText("node_modules (1.2 GB) holds build files: the next build makes them again.");
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("storage-delete-step-1.png"), animations: "disabled" });
  // Cancel at the first step deletes nothing.
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(deletes).toEqual([]);
  await page.getByRole("button", { name: /^Delete 3 / }).click();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  const sure = page.getByRole("dialog", { name: "Are you sure?", exact: true });
  await expect(sure).toContainText("This can't be undone: they're deleted for good, not moved to the Trash.");
  await page.screenshot({ ...shot("storage-delete-step-2.png"), animations: "disabled" });
  await sure.getByRole("button", { name: "Yes, delete", exact: true }).click();
  await expect(sure).toHaveCount(0);
  expect(deletes).toEqual([{ ids: ["i1", "i2", "i3"] }]);
  await expect(page.getByText("Deleted 3 items (4.7 GB).", { exact: true })).toBeVisible();
});
