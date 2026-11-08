import type { Page, WebSocketRoute } from "@playwright/test";
import { test, expect, noHorizontalOverflow, openGroupSettings } from "./fixtures";

const HUB = "http://127.0.0.1:8451";
// CT_SHOTS: a folder to save the phone screens in, to look at them.
const shot = (name: string) => (process.env.CT_SHOTS ? { path: `${process.env.CT_SHOTS}/${name}` } : {});
/** ConfirmButton doesn't take a quick double tap as its second step. */
const pastDoubleTap = (page: Page) => page.waitForTimeout(450);

/** The live updates, played here: what the app sends comes in `sent`, and `send` plays the hub's side. */
async function liveUpdates(page: Page) {
  let socket: WebSocketRoute | undefined;
  const sent: { t: string; [k: string]: unknown }[] = [];
  await page.routeWebSocket("**/api/ws?**", (ws) => {
    socket = ws;
    ws.onMessage((data) => {
      const e = JSON.parse(String(data));
      if (e.t === "ping") ws.send(JSON.stringify({ t: "pong" }));
      else sent.push(e);
    });
  });
  return {
    sent,
    send: (e: unknown) => socket!.send(JSON.stringify(e)),
    ready: () => expect.poll(() => !!socket).toBe(true),
    drop: () => socket!.close({ code: 1012, reason: "Browser test restart" }),
  };
}

type SignInSession = { id: string; provider: string; account: string; state: string; userCode: string | null; words: string; endedAt: number | null; [k: string]: unknown };

/**
 * The hub's side of a sign-in from the sign-in sheet (POST /api/signin and its session), played here: no agent's own
 * sign-in runs. `make(n, body)`: the n-th session asked for. Settings' older sign-in (a terminal, or Codex's device code
 * dialog) must not be asked for at all on a hub that has the sheet: `older` notes any call.
 */
async function signInPlayed(page: Page, make: (n: number, body: { provider: string; account: string }) => Partial<SignInSession>) {
  const sessions: SignInSession[] = [];
  const older: string[] = [];
  await page.route("**/api/accounts/*/*/login", (route) => {
    older.push(route.request().url());
    return route.fulfill({ status: 500, json: { error: "Settings' older sign-in was asked for" } });
  });
  await page.route("**/api/signin", (route) => {
    const body = route.request().postDataJSON() as { provider: string; account: string };
    const now = Date.now();
    const s: SignInSession = { id: `si_e2e${sessions.length + 1}`, provider: body.provider, account: body.account, accountLabel: null, machine: { id: "h_e2e", name: "Test hub" }, method: "device", state: "open", url: "https://example.com/login", userCode: null, wantsCode: false, codesSent: 0, codeRefused: false, words: "", startedAt: now, expiresAt: now + 15 * 60_000, endedAt: null, ...make(sessions.length + 1, body) };
    sessions.push(s);
    return route.fulfill({ json: s });
  });
  await page.route("**/api/signin/*", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop();
    const s = sessions.find((x) => x.id === id);
    if (!s) return route.fulfill({ status: 404, json: { error: "That sign-in has ended and gone. Start a new one.", code: "gone" } });
    if (route.request().method() === "DELETE" && !s.endedAt) Object.assign(s, { state: "cancelled", endedAt: Date.now(), words: "Sign-in stopped." });
    return route.fulfill({ json: s });
  });
  return { sessions, older };
}

test("accounts can be named, signed in independently, renamed and removed", async ({ page, request, token }) => {
  const auth = { authorization: `Bearer ${token}` };
  let accountId = "";
  // Each account's Sign in opens the sign-in sheet for that account: Codex's device code, played here.
  const played = await signInPlayed(page, (_n, b) => ({ accountLabel: "Browser Work", userCode: "WORK123", words: "Open the sign-in link on any device, sign in, and enter this code: WORK123.", account: b.account }));
  await page.goto("/#/setup");
  const card = page.getByRole("region", { name: "Codex accounts", exact: true });
  await card.getByRole("button", { name: "Add another sign-in", exact: true }).click();
  await page.getByRole("textbox", { name: "Account name", exact: true }).fill("Browser Work");
  await page.getByRole("dialog").getByRole("button", { name: "Save and sign in", exact: true }).click();
  // Straight on to signing it in.
  const sheet = page.getByRole("dialog", { name: /^Sign in to Codex \(Browser Work\) on / });
  await expect(sheet).toContainText("WORK123");
  const work = card.locator("div").filter({ has: page.getByText("Browser Work", { exact: true }) }).filter({ has: page.getByRole("button", { name: "Rename", exact: true }) }).last();
  const records = await (await request.get("http://127.0.0.1:8451/api/accounts", { headers: auth })).json();
  const record = records.find((a: { label: string }) => a.label === "Browser Work");
  accountId = record.id;
  try {
    // That account's sign-in, not the agent's own.
    expect(played.sessions.map((s) => [s.provider, s.account])).toEqual([["codex", accountId]]);
    // Main is already signed in: its status must not close Work's pending sign-in.
    await page.waitForTimeout(100);
    await expect(sheet).toBeVisible();
    await noHorizontalOverflow(page);
    // Put away, not stopped: its own Sign in comes back to the same sign-in instead of starting another.
    await sheet.getByRole("button", { name: "Close", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await work.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(sheet).toContainText("WORK123");
    expect(played.sessions).toHaveLength(1);
    await sheet.getByRole("button", { name: "Close", exact: true }).click();
    expect(played.older).toEqual([]);
    await work.getByRole("button", { name: "Rename", exact: true }).click();
    await page.getByRole("textbox", { name: "Account name", exact: true }).fill("Browser Personal");
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    await expect(card.getByText("Browser Personal", { exact: true })).toBeVisible();
    const renamed = card.locator("div").filter({ has: page.getByText("Browser Personal", { exact: true }) }).filter({ has: page.getByRole("button", { name: "Remove", exact: true }) }).last();
    page.once("dialog", (dialog) => dialog.accept());
    await renamed.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(card.getByText("Browser Personal", { exact: true })).toHaveCount(0);
  } finally { await request.delete(`http://127.0.0.1:8451/api/accounts/codex/${accountId}`, { headers: auth }); }
});

test("two members of the same agent keep their selected account and scoped model list", async ({ page, request, token }) => {
  const auth = { authorization: `Bearer ${token}` };
  const account = await (await request.post("http://127.0.0.1:8451/api/accounts", { headers: auth, data: { provider: "codex", label: "Team Work" } })).json();
  const room = await (await request.post("http://127.0.0.1:8451/api/rooms", { headers: auth, data: { name: "Multi account", mode: "direct" } })).json();
  await request.post(`http://127.0.0.1:8451/api/rooms/${room.id}/members`, { headers: auth, data: { provider: "codex", handle: "personal", config: { account: "default" } } });
  await page.route("**/api/providers/codex/models*", (route) => {
    const selected = new URL(route.request().url()).searchParams.get("account") ?? "default";
    return route.fulfill({ json: { provider: "codex", accountId: selected, live: true, models: [{ id: `${selected}-model`, label: selected === "default" ? "Personal model" : "Work model", efforts: ["low"], defaultEffort: "low", isDefault: true }] } });
  });
  try {
    await page.goto(`/#/room/${room.id}`);
    await expect(page.locator(".topbar h1")).toHaveText("Multi account");
    // A room is a group chat now: its agents are added and changed from its settings.
    const settings = await openGroupSettings(page);
    await settings.getByRole("button", { name: "Add an agent", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add an agent", exact: true });
    await dialog.getByRole("button", { name: /^Codex / }).click();
    await dialog.getByRole("combobox", { name: "Account", exact: true }).selectOption(account.id);
    await dialog.getByText("Advanced: name, model, effort, instructions", { exact: true }).click();
    await expect(dialog.getByRole("option", { name: "Work model", exact: true })).toHaveCount(1);
    await expect(dialog.getByRole("option", { name: "Personal model", exact: true })).toHaveCount(0);
    await dialog.getByPlaceholder("codex", { exact: true }).fill("work");
    await dialog.getByRole("button", { name: "Add to chat", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const state = await (await request.get("http://127.0.0.1:8451/api/state", { headers: auth })).json();
    const members = state.members.filter((m: { roomId: string }) => m.roomId === room.id);
    expect(members).toHaveLength(2);
    expect(members.find((m: { handle: string }) => m.handle === "work").config.account).toBe(account.id);
    expect(members.find((m: { handle: string }) => m.handle === "personal").config.account ?? "default").toBe("default");
    await expect(settings.getByRole("listitem").filter({ hasText: "@work" })).toContainText("Team Work");
    await noHorizontalOverflow(page);
  } finally {
    await request.delete(`http://127.0.0.1:8451/api/rooms/${room.id}`, { headers: auth });
    await request.delete(`http://127.0.0.1:8451/api/accounts/codex/${account.id}`, { headers: auth });
  }
});

test("usage from two accounts of the same provider never overwrites the other", async ({ page }) => {
  await page.route("**/api/state", async (route) => {
    const snap = await (await route.fetch()).json();
    snap.accounts = ["default", "work"].map((id) => ({ provider: "codex", id, label: id === "default" ? "Personal" : "Work", signedIn: true, account: `${id}@example.com`, plan: "Test", error: null, checkedAt: Date.now() }));
    snap.usage = ["default", "work"].map((id, i) => ({ provider: "codex", accountId: id, account: `${id}@example.com`, plan: "Test", windows: [{ label: "Weekly", usedPercent: i ? 72 : 12, resetsAt: null }], updatedAt: Date.now() }));
    await route.fulfill({ json: snap });
  });
  await page.goto("/#/usage");
  await expect(page.getByRole("heading", { name: "Codex · Personal", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Codex · Work", exact: true })).toBeVisible();
  await expect(page.getByText("12% used", { exact: true })).toBeVisible();
  await expect(page.getByText("72% used", { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
});

test("new chat selects an account before creating its agent", async ({ page, request, token }) => {
  const auth = { authorization: `Bearer ${token}` };
  const account = await (await request.post("http://127.0.0.1:8451/api/accounts", { headers: auth, data: { provider: "codex", label: "New room Work" } })).json();
  let roomId = "";
  await page.route("**/api/settings/defaults", (route) => route.fulfill({ json: { mode: "direct", agents: ["codex"], maxHops: 5, rounds: 1, parallel: false, agent: {} } }));
  try {
    await page.goto("/#/agent/codex");
    await page.getByRole("button", { name: "New chat", exact: true }).last().click();
    const dialog = page.getByRole("dialog", { name: "New chat with Codex", exact: true });
    await dialog.getByRole("combobox", { name: "Account", exact: true }).selectOption(account.id);
    await dialog.getByRole("button", { name: "Start chat", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    roomId = new URL(page.url()).hash.split("/").pop()!;
    const state = await (await request.get("http://127.0.0.1:8451/api/state", { headers: auth })).json();
    const members = state.members.filter((m: { roomId: string }) => m.roomId === roomId);
    expect(members).toHaveLength(1);
    expect(members[0].config.account).toBe(account.id);
    await noHorizontalOverflow(page);
  } finally {
    if (roomId) await request.delete(`http://127.0.0.1:8451/api/rooms/${roomId}`, { headers: auth });
    await request.delete(`http://127.0.0.1:8451/api/accounts/codex/${account.id}`, { headers: auth });
  }
});

test("an expired Codex sign-in says so, and Start again shows a fresh code", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const live = await liveUpdates(page);
  let accountId = "";
  // The hub's side of the sign-in is played here: Codex itself never runs.
  const played = await signInPlayed(page, (n, b) => {
    accountId = b.account;
    const code = n === 1 ? "OLD1-CODE" : "NEW2-CODE";
    return { accountLabel: "Browser Expiry", url: "https://auth.example/codex/device", userCode: code, words: `Open the sign-in link on any device, sign in, and enter this code: ${code}.` };
  });
  const expired = { state: "expired", endedAt: Date.now(), userCode: null, words: "Nobody finished the sign-in within 15 minutes, so Crosstalk stopped it. Start again when you're ready." };
  try {
    await page.goto("/#/settings");
    await live.ready();
    const card = page.getByRole("region", { name: "Codex accounts", exact: true });
    await card.getByRole("button", { name: "Add another sign-in", exact: true }).click();
    await page.getByRole("textbox", { name: "Account name", exact: true }).fill("Browser Expiry");
    await page.getByRole("dialog").getByRole("button", { name: "Save and sign in", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: /^Sign in to Codex \(Browser Expiry\) on / });
    await expect(sheet).toContainText("OLD1-CODE");
    // Another sign-in ending (an earlier one, on another device) isn't this one ending.
    live.send({ t: "signin.session", session: { ...played.sessions[0], id: "si_elsewhere", ...expired } });
    await page.waitForTimeout(200);
    await expect(sheet).toContainText("OLD1-CODE");
    // This one runs out: the sheet says so at once, instead of showing a dead code.
    live.send({ t: "signin.session", session: { ...played.sessions[0], ...expired } });
    await expect(sheet.getByRole("status")).toHaveText(expired.words);
    await expect(sheet).not.toContainText("OLD1-CODE");
    // Its way on is Start again, here: never a terminal.
    await expect(sheet.getByRole("button", { name: "Start again", exact: true })).toBeFocused();
    await expect(sheet).not.toContainText("terminal");
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("sign-in-code-expired.png"), animations: "disabled" });
    await sheet.getByRole("button", { name: "Start again", exact: true }).click();
    await expect(sheet).toContainText("NEW2-CODE");
    await expect(sheet.getByRole("status")).toHaveText("Open the sign-in link on any device, sign in, and enter this code: NEW2-CODE.");
    expect(played.sessions.map((s) => s.userCode)).toEqual(["OLD1-CODE", "NEW2-CODE"]);
    // Approved: it says so, and Done closes it.
    live.send({ t: "signin.session", session: { ...played.sessions[1], state: "done", endedAt: Date.now(), words: "Codex (Browser Expiry) is signed in on Test hub (Plus, me@example.com)." } });
    await expect(sheet.getByRole("status")).toHaveText("Codex (Browser Expiry) is signed in on Test hub (Plus, me@example.com).");
    await sheet.getByRole("button", { name: "Done", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    expect(played.older).toEqual([]);
  } finally {
    if (accountId) await request.delete(`${HUB}/api/accounts/codex/${accountId}`, { headers: { authorization: `Bearer ${token}` } });
  }
});

test("Claude Code's Sign in in Settings opens the sign-in sheet: a link and a box for the code, no terminal", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let accountId = "";
  const played = await signInPlayed(page, (_n, b) => {
    accountId = b.account;
    return { method: "paste", accountLabel: "Browser Sheet", url: "https://claude.com/cai/oauth/authorize?code=true&state=browser-test", wantsCode: true, words: "Open the sign-in link and sign in with the Claude account that has your plan. The page then shows a code: copy all of it and paste it here." };
  });
  try {
    await page.goto("/#/settings");
    const card = page.getByRole("region", { name: "Claude Code accounts", exact: true });
    await card.getByRole("button", { name: "Add another sign-in", exact: true }).click();
    await page.getByRole("textbox", { name: "Account name", exact: true }).fill("Browser Sheet");
    await page.getByRole("dialog").getByRole("button", { name: "Save and sign in", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: /^Sign in to Claude Code \(Browser Sheet\) on / });
    await expect(sheet.getByRole("link", { name: "Open the sign-in page", exact: true })).toHaveAttribute("href", "https://claude.com/cai/oauth/authorize?code=true&state=browser-test");
    await expect(sheet.getByRole("textbox", { name: "Code from the sign-in page", exact: true })).toBeEnabled();
    // Nothing of a terminal: no screen of Claude Code's own on any device, and no call for one.
    await expect(sheet.locator(".xterm")).toHaveCount(0);
    expect(played.older).toEqual([]);
    expect(played.sessions.map((s) => [s.provider, s.account])).toEqual([["claude", accountId]]);
    await noHorizontalOverflow(page);
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => played.sessions[0].state).toBe("cancelled");
  } finally {
    if (accountId) await request.delete(`${HUB}/api/accounts/claude/${accountId}`, { headers: { authorization: `Bearer ${token}` } });
  }
});

test("a hub from before sign-ins from the phone: its sign-in terminal's paste field sends the code and Enter", async ({ page, context, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const live = await liveUpdates(page);
  let accountId = "";
  // That hub's state says nothing of sign-ins from the phone: Settings signs in the older way, in the agent's terminal
  // (as it still does for Antigravity CLI).
  await page.route("**/api/state", async (route) => {
    const snap = await (await route.fetch()).json();
    delete snap.signIns;
    delete snap.signInSessions;
    await route.fulfill({ json: snap });
  });
  let output = "Browser didn't open? Use the url below to sign in:\r\n\r\nhttps://claude.ai/oauth/authorize?code=true&state=browser-test\r\n\r\nPaste code here if prompted > ";
  const info = { id: "pty_signin", title: "Sign in", command: "claude auth login", purpose: "login", provider: "claude", alive: true, exitCode: null, createdAt: Date.now() };
  // The terminal is played here: Claude Code's own sign-in never runs.
  await page.route("**/api/accounts/claude/*/login", (route) => {
    accountId = new URL(route.request().url()).pathname.split("/")[4];
    return route.fulfill({ json: { kind: "terminal", provider: "claude", ptyId: "pty_signin", command: "claude auth login", hint: "Open the link, sign in, then paste the code it gives you below." } });
  });
  let reads = 0;
  await page.route("**/api/pty/pty_signin", (route) => {
    if (route.request().method() === "GET") reads++;
    return route.fulfill({ json: route.request().method() === "DELETE" ? { ok: true } : { info, scrollback: output } });
  });
  // Nor is the sign-in page opened for real.
  await context.route("https://claude.ai/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>Sign in</title>" }));
  try {
    await page.goto("/#/settings");
    await live.ready();
    const card = page.getByRole("region", { name: "Claude Code accounts", exact: true });
    await card.getByRole("button", { name: "Add another sign-in", exact: true }).click();
    await page.getByRole("textbox", { name: "Account name", exact: true }).fill("Browser Paste");
    await page.getByRole("dialog").getByRole("button", { name: "Save and sign in", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Sign in to Claude Code · Browser Paste", exact: true });
    const field = dialog.getByRole("textbox", { name: "Paste the code here", exact: true });
    await expect(field).toBeVisible();
    // Back from the sign-in page, the code goes straight into the field.
    const popup = page.waitForEvent("popup");
    await dialog.getByRole("link", { name: "Open sign-in link", exact: true }).click();
    await (await popup).close();
    await page.bringToFront();
    await expect(field).toBeFocused();
    await field.fill(" abc-123_xyz ");
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("sign-in-paste-field.png"), animations: "disabled" });
    await dialog.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => live.sent.filter((e) => e.t === "pty.input").map((e) => e.data)).toContain("abc-123_xyz\r");
    await expect(field).toHaveValue("");
    // Back from Safari with the connection still up: nothing was missed, so the terminal isn't cleared and drawn again.
    const before = reads;
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // Past the wake check's few seconds: the socket answered it, so it's kept.
    await page.waitForTimeout(3_500);
    expect(reads).toBe(before);
    // The connection dropped meanwhile (the phone went to Safari): the terminal reads its output again, never frozen.
    output += "abc-123_xyz\r\nLogin successful.\r\n";
    await live.drop();
    await expect(dialog.locator(".xterm-rows")).toContainText("Login successful.");
    page.once("dialog", (d) => d.accept());
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  } finally {
    if (accountId) await request.delete(`${HUB}/api/accounts/claude/${accountId}`, { headers: { authorization: `Bearer ${token}` } });
  }
});

test("GitHub's one-time code shows large, with Copy and Press Enter", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const live = await liveUpdates(page);
  const info = { id: "pty_gh", title: "GitHub sign-in", command: "gh auth login --web", purpose: "login", provider: null, alive: true, exitCode: null, createdAt: Date.now() };
  await page.route("**/api/tools/github", (route) => route.fulfill({ json: { installed: true, version: "2.60.0", signedIn: false, account: null, error: null } }));
  // gh never runs: its terminal is played here.
  await page.route("**/api/tools/github/login", (route) => route.fulfill({ json: { kind: "terminal", ptyId: "pty_gh", command: "gh auth login --web", hint: "Copy the one-time code, press Enter here, then open the github.com/login/device link below and enter the code." } }));
  await page.route("**/api/pty/pty_gh", (route) => route.fulfill({ json: route.request().method() === "DELETE" ? { ok: true } : { info, scrollback: "\x1b[33m!\x1b[0m First copy your one-time code: \x1b[1m7A3F-9B2C\x1b[0m\r\nPress Enter to open https://github.com/login/device in your browser... " } }));
  await page.goto("/#/settings/more");
  await live.ready();
  await page.getByRole("region", { name: "GitHub", exact: true }).getByRole("button", { name: "Sign in with GitHub", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Sign in to GitHub", exact: true });
  const code = dialog.getByRole("group", { name: "One-time code", exact: true });
  await expect(code.locator(".code-big")).toHaveText("7A3F-9B2C");
  // Nothing to paste back for GitHub: the code goes the other way.
  await expect(dialog.getByRole("textbox", { name: "Paste the code here", exact: true })).toHaveCount(0);
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("github-sign-in-code.png"), animations: "disabled" });
  await code.getByRole("button", { name: "Press Enter", exact: true }).click();
  await expect.poll(() => live.sent.filter((e) => e.t === "pty.input").map((e) => e.data)).toContain("\r");
  page.once("dialog", (d) => d.accept());
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("GitHub Sign out takes two taps and says what it affects", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const machine = (await (await request.get(`${HUB}/api/state`, { headers: { authorization: `Bearer ${token}` } })).json()).hub.name as string;
  let fail = true;
  let signedIn = true;
  let signOuts = 0;
  await page.route("**/api/tools/github", (route) => route.fulfill(fail ? { status: 503, json: { error: "The hub is restarting." } } : { json: { installed: true, version: "2.60.0", signedIn, account: signedIn ? "octocat" : null, error: null } }));
  // Never the real gh: that's this Mac's own GitHub sign-in.
  await page.route("**/api/tools/github/logout", (route) => {
    signOuts++;
    signedIn = false;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/#/settings/more");
  const github = page.getByRole("region", { name: "GitHub", exact: true });
  // Couldn't check: it says so (not "Checking…" for ever), with Retry.
  await expect(github.getByRole("alert")).toHaveText(`Couldn't check GitHub on ${machine}: The hub is restarting.`);
  fail = false;
  await github.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(github).toContainText("Signed in as octocat.");
  await github.getByRole("button", { name: "Sign GitHub out", exact: true }).click();
  const asked = github.getByRole("group", { name: `Sign GitHub out on ${machine}? Agents can't push, and gh in Terminal there is signed out too.`, exact: true });
  await expect(asked).toBeVisible();
  await github.scrollIntoViewIfNeeded();
  await noHorizontalOverflow(page);
  await page.screenshot({ ...shot("github-sign-out-asks.png"), animations: "disabled" });
  // The first tap only asks; Cancel keeps it signed in.
  await asked.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(signOuts).toBe(0);
  await expect(github).toContainText("Connected");
  await github.getByRole("button", { name: "Sign GitHub out", exact: true }).click();
  await pastDoubleTap(page);
  await asked.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(github).toContainText("Not signed in");
  expect(signOuts).toBe(1);
});

test("an agent's Sign out says how many chats use the account", async ({ page, request, token }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const headers = { authorization: `Bearer ${token}` };
  const rooms = [
    await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "claude", name: "Count one" } })).json(),
    await (await request.post(`${HUB}/api/chats`, { headers, data: { provider: "claude", name: "Count two" } })).json(),
  ];
  // Never the real CLI: signing Main out would sign this Mac's own Claude Code out.
  let signOuts = 0;
  await page.route("**/api/accounts/claude/*/logout", (route) => {
    signOuts++;
    return route.fulfill({ json: { provider: "claude", id: "default", label: "Main", signedIn: true, account: "Browser fixture", plan: "test", authMethod: null, error: null, checkedAt: Date.now() } });
  });
  try {
    const state = await (await request.get(`${HUB}/api/state`, { headers })).json();
    const chats = new Set(state.members.filter((m: { provider: string; config?: { account?: string } }) => m.provider === "claude" && (m.config?.account ?? "default") === "default").map((m: { roomId: string }) => m.roomId)).size;
    expect(chats).toBeGreaterThanOrEqual(2);
    await page.goto("/#/settings");
    const accounts = page.getByRole("region", { name: "Claude Code accounts", exact: true });
    await accounts.getByRole("button", { name: "Sign out Claude Code · Main", exact: true }).click();
    const asked = accounts.getByRole("group", { name: `Sign Claude Code out on ${state.hub.name}? ${chats} chats use this account, and Claude Code in Terminal there is signed out too.`, exact: true });
    await expect(asked).toBeVisible();
    await asked.scrollIntoViewIfNeeded();
    await noHorizontalOverflow(page);
    await page.screenshot({ ...shot("agent-sign-out-asks.png"), animations: "disabled" });
    await asked.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(signOuts).toBe(0);
    await accounts.getByRole("button", { name: "Sign out Claude Code · Main", exact: true }).click();
    await pastDoubleTap(page);
    await asked.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect.poll(() => signOuts).toBe(1);
  } finally {
    for (const r of rooms) await request.delete(`${HUB}/api/rooms/${r.id}`, { headers });
  }
});

test("a stray tap outside Add a custom model asks before discarding", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/settings");
  await page.getByRole("region", { name: "Codex accounts", exact: true }).getByRole("button", { name: "Add a custom model", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a custom model for Codex", exact: true });
  const models = dialog.getByPlaceholder("Check fills this in", { exact: true });
  await models.fill("qwen3-coder");
  // A tap beside the dialog, as a thumb easily does.
  await page.mouse.click(8, 8);
  await expect(page.getByRole("alert").filter({ hasText: "Discard changes?" })).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(models).toHaveValue("qwen3-coder");
  await page.mouse.click(8, 8);
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
