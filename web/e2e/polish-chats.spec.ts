import type { APIRequestContext, Locator, Page } from "@playwright/test";
import type { AgentAccount, Member, Room } from "@crosstalk/shared";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { otherMachine, pong } from "./otherMachine";

// Chats as a person uses them: pinning, renaming, the chat list's groups, and searching when a machine is down.
// Every test here describes something today's code gets wrong, so **each one is expected to fail** until it's fixed;
// which line is wrong is said above each test. The happy paths are already covered by pins.spec.ts, chatFold.spec.ts,
// chatRefinement.spec.ts and search.spec.ts — nothing here repeats them.

const HUB = "http://127.0.0.1:8451";
const APP = "http://127.0.0.1:5198";
const FOLDED_KEY = "crosstalk.sidebar.folded";
// CT_SHOTS: a folder to save the screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: join(process.env.CT_SHOTS, name) } : {});
const project = () => test.info().project.name;
/** Once per browser, at a phone's width: that's the screen these all have to work on. */
const onPhone = () => test.skip(!/-390$/.test(project()), "Once per browser, at 390.");
/** The narrowest phone too, where two headings of one name are cut with an ellipsis. */
const onPhones = () => test.skip(!/-(320|390)$/.test(project()), "Phone widths: the 320 and 390 projects.");

async function chat(request: APIRequestContext, token: string, name: string, extra: Record<string, unknown> = {}) {
  const headers = { authorization: `Bearer ${token}` };
  const room: Room = await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "codex", name, ...extra } })).json();
  return { room, cleanup: () => request.delete(`${HUB}/api/rooms/${room.id}`, { headers }) };
}

/** The test hub's chats as it keeps them, by id. */
async function saved(request: APIRequestContext, token: string): Promise<Map<string, Room>> {
  const state = await (await request.get(`${HUB}/api/state`, { headers: { authorization: `Bearer ${token}` } })).json();
  return new Map((state.rooms as Room[]).map((r) => [r.id, r]));
}

/** The chats drawer on a phone, opened. */
async function drawer(page: Page) {
  const show = page.getByRole("button", { name: /^Show chats/ });
  if (await show.count()) await show.click();
  const side = page.getByRole("complementary", { name: "Chats", exact: true });
  await expect(side).toBeVisible();
  return side;
}

/** Chat settings, from the chat's top bar. */
async function chatSettings(page: Page) {
  await page.getByRole("button", { name: "Chat settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Chat settings", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The list holds only these chats (whatever else the shared test hub has), in the order given, each a second apart. */
async function onlyThese(page: Page, ids: string[]) {
  const place = new Map(ids.map((id, i) => [id, i]));
  await page.route((url) => url.origin === APP && url.pathname === "/api/state", async (route) => {
    const s = await (await route.fetch()).json();
    s.rooms = (s.rooms as Room[]).filter((r) => place.has(r.id)).map((r) => ({ ...r, updatedAt: Date.now() - (place.size - place.get(r.id)!) * 1000 }));
    s.members = (s.members as Member[]).filter((m) => place.has(m.roomId));
    await route.fulfill({ json: s });
  });
}

/** A chat's row and its ⋯, wherever it is in the list. */
const rowOf = (where: Locator, name: string) => where.locator(".csb-item").filter({ has: where.page().locator(".csb-chat-name", { hasText: new RegExp(`^${name}$`) }) });
const moreOf = (where: Locator, name: string) => rowOf(where, name).getByRole("button", { name: `Options for ${name}`, exact: true });
const kept = (page: Page) => page.evaluate((key) => localStorage.getItem(key), FOLDED_KEY).then((v) => JSON.parse(v ?? "null"));

/**
 * EXPECTED TO FAIL. The mirror of chatFold.spec.ts "a chat unpinned into a folded group opens it": unpinning tells the
 * list where the row went (ChatRow.tsx onUnpin calls `onUnpinned`, ChatSidebar.tsx wires it to `setFolded(..., false)`),
 * but pinning has no such callback — ChatRow.tsx `onPin` only runs `setPin`. With Pinned folded, the row leaves its
 * agent's group (it's in `pins.pinned` now), the Pinned section draws nothing (GroupFold.tsx `{folded ? null : children}`),
 * and `usePinnedList`'s refocus finds no `[data-pin-row]` to put focus back on — so the chat and the focus both vanish.
 */
test("pinning a chat while Pinned is folded keeps it in view, instead of swallowing the row and the focus", async ({ page, request, token }) => {
  onPhone();
  await page.setViewportSize({ width: 390, height: 844 });
  const tag = Math.random().toString(36).slice(2, 6);
  const a = await chat(request, token, `Fix login ${tag}`);
  const b = await chat(request, token, `Write docs ${tag}`);
  try {
    await onlyThese(page, [a.room.id, b.room.id]);
    // One chat is already pinned, so the Pinned group is there to fold.
    await request.post(`${HUB}/api/rooms/${a.room.id}/pin`, { headers: { authorization: `Bearer ${token}` }, data: { pinned: true, order: -1 } });
    await page.goto("/");
    const side = await drawer(page);
    const pinned = side.getByRole("region", { name: "Pinned", exact: true });
    await expect(rowOf(pinned, a.room.name)).toBeVisible();

    // Pinned folded away on this device.
    await pinned.getByRole("button", { name: "Hide pinned chats", exact: true }).click();
    await expect(pinned.locator(".csb-fold-said")).toHaveText("1 chat");
    await expect(rowOf(pinned, a.room.name)).toHaveCount(0);

    // The other chat is pinned from its ⋯, by keyboard, so where focus lands is plain to see.
    const codex = side.locator(".csb-group").filter({ has: page.locator(".csb-agent-name", { hasText: "Codex" }) });
    await moreOf(codex, b.room.name).focus();
    await page.keyboard.press("Enter");
    await rowOf(codex, b.room.name).getByRole("button", { name: "Pin to top", exact: true }).click();
    await expect.poll(async () => (await saved(request, token)).get(b.room.id)?.pinnedAt ?? 0).toBeGreaterThan(0);
    await page.screenshot({ ...shot("polish-chats-pin-into-folded.png"), animations: "disabled" });

    // The group it went to opens, the way unpinning opens the one the row drops into: you see where the chat went,
    // and focus went with it. Today: Pinned stays folded, the row is nowhere, and focus is on the document.
    await expect(pinned.getByRole("button", { name: "Hide pinned chats", exact: true })).toBeVisible();
    await expect(rowOf(pinned, b.room.name)).toBeVisible();
    await expect(moreOf(pinned, b.room.name)).toBeFocused();
    expect(await kept(page)).toEqual({});
  } finally {
    await a.cleanup();
    await b.cleanup();
  }
});

/**
 * EXPECTED TO FAIL. ChatScreen.tsx `ChatSettingsDialog`: `dirty` counts `name.trim() !== room.name`, so an emptied Name
 * box enables Save — but `save()` guards the rename with `if (name.trim() && ...)`, so Save closes the dialog having
 * changed nothing and said nothing. Either the name can't be empty (Save stays off) or it says so; silence is the one
 * thing it mustn't do. GroupSettings.tsx has the same pair of lines for a group chat.
 */
test("a chat's name can't be emptied by accident: Save doesn't quietly do nothing", async ({ page, request, token }) => {
  onPhone();
  await page.setViewportSize({ width: 390, height: 844 });
  const x = await chat(request, token, `Fix login ${Math.random().toString(36).slice(2, 6)}`);
  try {
    await page.goto(`/#/room/${x.room.id}`);
    await expect(page.getByRole("heading", { name: x.room.name, exact: true })).toBeVisible();
    const dialog = await chatSettings(page);
    const name = dialog.getByRole("textbox", { name: "Name", exact: true });
    await name.fill("");
    await page.screenshot({ ...shot("polish-chats-empty-name.png"), animations: "disabled" });

    // Nothing to save: an empty name isn't a change the hub will take.
    await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

    // And if it is offered, tapping it has to say what's wrong rather than close on a change that never happened.
    if (await dialog.getByRole("button", { name: "Save", exact: true }).isEnabled()) {
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("alert")).toContainText(/name/i);
    }
    expect((await saved(request, token)).get(x.room.id)?.name).toBe(x.room.name);
  } finally {
    await x.cleanup();
  }
});

/**
 * EXPECTED TO FAIL. The twin of pins.spec.ts "Chat settings never undoes a pin or an unpin made on another device while
 * it's open" — the Pinned switch is guarded (`pinnedAtOpen`, and `pinned !== isPinned(room)` before it writes), but the
 * Name box isn't: ChatScreen.tsx keeps `name` from when the dialog opened, `dirty` compares it with the live `room.name`,
 * and `save()` sends it whenever the two differ. So a rename made on another device turns this dialog dirty on its own,
 * and the next Save — even one meant only for the Pinned switch — writes the old name back over it.
 */
test("Chat settings never undoes a rename made on another device while it's open", async ({ page, request, token }) => {
  onPhone();
  await page.setViewportSize({ width: 390, height: 844 });
  const headers = { authorization: `Bearer ${token}` };
  const x = await chat(request, token, `Fix login ${Math.random().toString(36).slice(2, 6)}`);
  const renamed = `Payments API ${Math.random().toString(36).slice(2, 6)}`;
  // What the page hears from the hub over its live connection, so the test waits for the rename to be drawn.
  const frames: string[] = [];
  page.on("websocket", (ws) => ws.on("framereceived", (f) => frames.push(String(f.payload))));
  try {
    await page.goto(`/#/room/${x.room.id}`);
    await expect(page.getByRole("heading", { name: x.room.name, exact: true })).toBeVisible();
    const dialog = await chatSettings(page);
    await expect(dialog.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(x.room.name);

    // Renamed on another device, and heard here.
    const from = frames.length;
    expect((await request.patch(`${HUB}/api/rooms/${x.room.id}`, { headers, data: { name: renamed } })).ok()).toBe(true);
    await expect.poll(() => frames.slice(from).some((f) => f.includes('"t":"room"') && f.includes(renamed))).toBe(true);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

    // Nothing was typed here, so there's nothing of this device's to save.
    await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await page.screenshot({ ...shot("polish-chats-remote-rename.png"), animations: "disabled" });

    // Something else changed and saved: the new name stays, exactly as a pin made elsewhere does.
    await dialog.getByRole("checkbox", { name: "Pinned", exact: true }).click({ force: true });
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await saved(request, token)).get(x.room.id)?.pinnedAt ?? 0).toBeGreaterThan(0);
    expect((await saved(request, token)).get(x.room.id)?.name).toBe(renamed);
  } finally {
    await x.cleanup();
  }
});

/**
 * EXPECTED TO FAIL. chatIdentity.ts `chatGroups` tells two services of one name apart by adding the agent that drives
 * them — but it only compares services with each other, never with the agents' own groups, so a model of yours called
 * "Codex" gives the list two headings reading "Codex". ChatSidebar.tsx then works out a `where` for the second one,
 * and ServiceHeader puts it only in the button's `aria-label`: on screen the two headings are the same words. (The
 * same happens, without naming anything after an agent, when two machines each run a model of one name — the hub
 * refuses two accounts of one name on one machine, so that case needs two machines to reach.)
 */
test("two chat-list groups never read the same, even when a model of yours is named after an agent", async ({ page, request, token }) => {
  onPhones();
  const width = page.viewportSize()!.width;
  await page.setViewportSize({ width, height: 844 });
  const headers = { authorization: `Bearer ${token}` };
  const model = "qwen3.8-9b";
  // A model server of yours that the person named "Codex" — the hub allows it: the agent's own sign-in is called "Main".
  const account: AgentAccount = await (await request.post(`${HUB}/api/accounts/endpoint`, { headers, data: { provider: "codex", label: "Codex", baseUrl: "http://127.0.0.1:8099", apiKey: "", models: [model], contextWindow: 16384 } })).json();
  const own = await chat(request, token, `On the sign-in ${Math.random().toString(36).slice(2, 6)}`);
  const mine = await chat(request, token, `On my own model ${Math.random().toString(36).slice(2, 6)}`, { account: account.id, model });
  try {
    await onlyThese(page, [own.room.id, mine.room.id]);
    await page.goto("/");
    const side = await drawer(page);
    await expect(rowOf(side, mine.room.name)).toBeVisible();
    await page.screenshot({ ...shot(`polish-chats-two-headings-${width}.png`), animations: "disabled" });

    // Every group in the list is named something of its own: two rows of the same words are two groups a person
    // can't tell apart (and on a phone both are cut with the same ellipsis).
    const headings = (await side.locator(".csb-group .csb-agent-name").allTextContents()).map((t) => t.trim());
    expect(new Set(headings).size, `two groups read the same: ${headings.join(" / ")}`).toBe(headings.length);
  } finally {
    await own.cleanup();
    await mine.cleanup();
    await request.delete(`${HUB}/api/accounts/codex/${account.id}`, { headers });
  }
});

/**
 * EXPECTED TO FAIL. useMessageSearch.ts gives a machine that isn't answering `busy: m.downSince === null` — false, by
 * definition, for the only machines whose Try again calls `reconnectNow`. So MessageHits.tsx draws that button enabled
 * and reading "Try again" however often it's tapped: nothing on screen changes. The same sidebar's machine line does
 * this right (ChatSidebar.tsx `TryNow`, checked in screens.spec.ts: "Trying…", disabled, for a moment).
 */
test("search: Try again on a machine that isn't answering says it's trying", async ({ page, request, token }) => {
  onPhone();
  await page.setViewportSize({ width: 390, height: 844 });
  const at = Date.now();
  const linuxRoom = { id: "r_linux", name: "Deploy notes", cwd: "/home/me/deploy", mode: "direct", leadMemberId: "mb_linux", maxHops: 0, rounds: 1, parallel: false, createdAt: at, updatedAt: at, archived: false, chat: { provider: "codex", origin: "web" } } as Room;
  const linuxMember = { id: "mb_linux", roomId: "r_linux", handle: "codex", provider: "codex", model: null, role: "", permissionMode: "ask", status: "idle", statusDetail: null, config: {}, createdAt: at, position: 0 } as Member;
  const linux = await otherMachine(page, token, { port: 8481, rooms: [linuxRoom], members: [linuxMember] });
  await page.routeWebSocket("ws://127.0.0.1:5198/api/ws?**", pong);
  const x = await chat(request, token, `Needle here ${Math.random().toString(36).slice(2, 6)}`);
  try {
    await page.goto("/");
    const side = await drawer(page);
    // Both machines up first: one coming up would ask again on its own.
    await expect(side.getByRole("button", { name: /^Deploy notes/ })).toBeVisible();
    linux.refuse(true);
    await expect(side.locator(".csb-machine").filter({ hasText: "Linux box isn't answering" })).toBeVisible();

    await side.getByRole("textbox", { name: "Search chats", exact: true }).fill("needle");
    const problem = side.getByRole("region", { name: "In messages", exact: true }).locator(".search-problem");
    await expect(problem).toContainText("Couldn't search Linux box. It isn't answering.");
    await problem.getByRole("button", { name: "Try again", exact: true }).click();
    await page.screenshot({ ...shot("polish-chats-search-retry.png"), animations: "disabled" });

    // A tap has to show it did something, as Try now on the machine's own line does.
    await expect(problem.getByRole("button", { name: "Trying…", exact: true })).toBeDisabled();
  } finally {
    linux.refuse(false);
    await x.cleanup();
  }
});

/**
 * EXPECTED TO FAIL before the fix. ChatScreen.tsx `save()` wrote the name and the reachability switch, and only then
 * asked about the account switch ("Switching accounts starts a fresh … session. Continue?"). Cancel there returned out
 * of the save: the rename was already written, the pin wasn't, the account hadn't changed, and nothing said so — a
 * Save that half went through. The question belongs before the first write, so Cancel leaves the dialog as it was.
 */
test("Cancelling the account question saves nothing at all, instead of half the dialog", async ({ page, request, token }) => {
  onPhone();
  await page.setViewportSize({ width: 390, height: 844 });
  const headers = { authorization: `Bearer ${token}` };
  const tag = Math.random().toString(36).slice(2, 6);
  // Two models of your own, so the chat's settings offer a choice of account whatever this hub is signed in to.
  const endpoint = (label: string) => request.post(`${HUB}/api/accounts/endpoint`, { headers, data: { provider: "codex", label, baseUrl: "http://127.0.0.1:8099", apiKey: "", models: ["qwen3-8b"], contextWindow: 16384 } }).then((r) => r.json() as Promise<AgentAccount>);
  const [one, two] = [await endpoint(`One ${tag}`), await endpoint(`Two ${tag}`)];
  const x = await chat(request, token, `Fix login ${tag}`, { account: one.id, model: "qwen3-8b" });
  const renamed = `Payments API ${tag}`;
  const asked: string[] = [];
  page.on("dialog", (d) => {
    asked.push(d.message());
    void d.dismiss();
  });
  try {
    await page.goto(`/#/room/${x.room.id}`);
    await expect(page.getByRole("heading", { name: x.room.name, exact: true })).toBeVisible();
    const dialog = await chatSettings(page);

    // A rename, a pin and another account, all in one go.
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(renamed);
    await dialog.getByRole("checkbox", { name: "Pinned", exact: true }).click({ force: true });
    await dialog.getByRole("combobox", { name: "Account", exact: true }).selectOption(two.id);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();

    // The question is asked, and answered with Cancel.
    await expect.poll(() => asked.length).toBe(1);
    expect(asked[0]).toContain("fresh");
    await page.screenshot({ ...shot("polish-chats-account-cancel.png"), animations: "disabled" });

    // Nothing was written: not the name, not the pin. The dialog stays open with everything still to save.
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    const room = (await saved(request, token)).get(x.room.id);
    expect(room?.name).toBe(x.room.name);
    expect(room?.pinnedAt ?? 0).toBe(0);
  } finally {
    await x.cleanup();
    await request.delete(`${HUB}/api/accounts/codex/${one.id}`, { headers });
    await request.delete(`${HUB}/api/accounts/codex/${two.id}`, { headers });
  }
});
