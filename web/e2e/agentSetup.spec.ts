import type { Page, WebSocketRoute } from "@playwright/test";
import type { SetupChecklist, SetupItem } from "@crosstalk/shared";
import { test, expect, noHorizontalOverflow } from "./fixtures";

// Settings → Set up with an AI agent (views/AgentSetupSection.tsx). The hub's checklist is played here (the test hub
// runs on a real Mac, whose setup mustn't matter), and Add for me's terminal too: nothing runs on the machine.

const BIN = "/Users/me/.local/bin/crosstalk-hub";
const CLAUDE = `claude mcp add --scope user crosstalk-setup -- ${BIN} setup-mcp`;
const CODEX = `codex mcp add crosstalk-setup -- ${BIN} setup-mcp`;
const PROMPT = "Use the crosstalk-setup tools to finish setting up Crosstalk on this machine; ask me before anything that needs my password.";

const item = (id: string, title: string, state: SetupItem["state"], over: Partial<SetupItem> = {}): SetupItem => ({ id, group: "hub", title, state, optional: false, detail: `${title}: what was found.`, fix: state === "done" ? null : { text: `How to fix ${title}.` }, ...over });

function checklist(items: SetupItem[]): SetupChecklist {
  const req = items.filter((i) => !i.optional);
  const n = (s: string) => req.filter((i) => i.state === s).length;
  return {
    schema: 1,
    checkedAt: Date.now(),
    hub: { running: true, version: "0.4.1", name: "Mac mini", platform: "darwin", arch: "arm64", url: "https://mini.tail1.ts.net", localUrl: "http://127.0.0.1:7420", binary: BIN, service: "launchd", update: null },
    summary: { total: req.length, done: n("done"), missing: n("missing"), user: n("user"), unknown: n("unknown") },
    items,
    connect: { claude: CLAUDE, codex: CODEX, gemini: `gemini mcp add --scope user crosstalk-setup ${BIN} setup-mcp`, cli: `${BIN} setup --json`, guide: "http://127.0.0.1:7420/setup.md", prompt: PROMPT },
  };
}

const LEFT = checklist([
  item("service", "Runs as a service", "done"),
  item("version", "Version", "done"),
  item("https", "HTTPS address", "missing", { group: "network", fix: { text: "Publish Crosstalk on your tailnet:", command: "/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=443 http://127.0.0.1:7420" } }),
  item("devices", "Paired devices", "user", { group: "devices", fix: { text: "Make a one-time code, then type it on the phone.", command: `${BIN} pair 15`, screen: "Settings → Devices → Pair a new device", target: "devices" } }),
  item("tailscale", "Tailscale", "user", { group: "network", fix: { text: "Turn off key expiry for it in Tailscale's admin console.", url: "https://login.tailscale.com/admin/machines" } }),
  item("agent.claude", "Claude Code", "done", { group: "agents" }),
  item("agent.codex", "Codex", "missing", { group: "agents", optional: true, fix: { text: "Install it with OpenAI's official installer:", command: 'npm install -g --prefix "$HOME/.npm-global" @openai/codex@latest' } }),
]);
const ALL_DONE = checklist(LEFT.items.map((i) => (i.optional ? i : { ...i, state: "done" as const, fix: null })));

/** The terminal "Add for me" opens, as the hub would report it: still running unless a test ends it. */
const PTY = { id: "pty_setup", title: "Add setup tools to Claude Code", command: CLAUDE, purpose: "install" as const, provider: "claude" as const, alive: true, exitCode: null, createdAt: Date.now() };

/** The hub's answers: /api/setup (any query), Check again and Add for me. Each request is noted. */
async function hub(page: Page, lists: { get: () => SetupChecklist | { status: number; error: string }; recheck?: () => SetupChecklist; pty?: () => { exitCode: number | null; output: string } }) {
  const seen: string[] = [];
  await page.route((url) => url.pathname === "/api/setup", async (r) => {
    seen.push(`GET ${new URL(r.request().url()).search}`);
    const answer = lists.get();
    if ("status" in answer) return r.fulfill({ status: answer.status, json: { error: answer.error } });
    await r.fulfill({ json: answer });
  });
  await page.route("**/api/setup/recheck", async (r) => {
    seen.push("recheck");
    await r.fulfill({ json: (lists.recheck ?? lists.get)() });
  });
  await page.route("**/api/setup/connect", async (r) => {
    seen.push(`connect ${(r.request().postDataJSON() as { agent: string }).agent}`);
    await r.fulfill({ json: PTY });
  });
  await page.route("**/api/pty/pty_setup", async (r) => {
    if (r.request().method() === "DELETE") {
      seen.push("pty closed");
      return r.fulfill({ json: { ok: true } });
    }
    // How the agent's own command ended, which is what the dialog reads to say where the setup tools stand.
    const end = lists.pty?.();
    return r.fulfill({ json: { info: { ...PTY, alive: !end, exitCode: end?.exitCode ?? null }, scrollback: end?.output ?? "" } });
  });
  return seen;
}

/** What the page copies goes to `window.copied` instead of the clipboard (which tests can't read in every engine). */
async function catchCopies(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { copied: string[] };
    w.copied = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { w.copied.push(text); } } });
  });
}
const copies = (page: Page) => page.evaluate(() => (window as unknown as { copied: string[] }).copied);

test("Settings starts with what's left to set up, and copies each agent's command and the prompt exactly", async ({ page }) => {
  await catchCopies(page);
  await hub(page, { get: () => LEFT });
  await page.goto("/#/settings");
  const section = page.locator(".agent-setup");
  await expect(page.getByRole("heading", { name: "Set up with an AI agent" })).toBeVisible();
  await expect(section.getByRole("status")).toHaveText("3 of 6 done · 2 need you · 1 to do");
  await expect(section).toContainText(CLAUDE);
  await expect(section).toContainText(CODEX);
  await expect(section).toContainText(PROMPT);
  await noHorizontalOverflow(page);
  await section.getByRole("button", { name: "Copy the Claude Code command" }).click();
  await section.getByRole("button", { name: "Copy the Codex command" }).click();
  await section.getByRole("button", { name: "Copy the prompt" }).click();
  await expect.poll(() => copies(page)).toEqual([CLAUDE, CODEX, `${PROMPT} If you don't have those tools, run ${BIN} setup --json instead, and read http://127.0.0.1:7420/setup.md.`]);
  // What needs you comes first; optional and done items are folded.
  await expect(section.locator(".as-row-btn").first()).toContainText("Needs you");
  await expect(section.locator(".as-row-btn").first()).toContainText("Paired devices");
  await expect(section.getByRole("button", { name: "Optional (1)" })).toHaveAttribute("aria-expanded", "false");
  await expect(section.getByRole("button", { name: "Done (3)" })).toHaveAttribute("aria-expanded", "false");
  await expect(section).not.toContainText("Runs as a service");
  // The "?" explains setup tools.
  await section.getByRole("button", { name: "What are setup tools?" }).click();
  await expect(section.getByRole("note")).toContainText("never give it your passwords");
});

test("a row opens to its fix: the command to copy, Go there for a Settings section, a web page to open", async ({ page }) => {
  await catchCopies(page);
  await hub(page, { get: () => LEFT });
  await page.goto("/#/settings");
  const section = page.locator(".agent-setup");
  // A row's button (its Copy button, once open, names the item too).
  const row = (title: string) => section.locator(".as-row-btn", { hasText: title });
  const devices = row("Paired devices");
  await devices.click();
  await expect(devices).toHaveAttribute("aria-expanded", "true");
  await expect(section).toContainText("Make a one-time code, then type it on the phone.");
  await expect(section).toContainText("In the app: Settings → Devices → Pair a new device");
  await section.getByRole("button", { name: "Copy the command for Paired devices" }).click();
  await expect.poll(() => copies(page)).toEqual([`${BIN} pair 15`]);
  // One row is open at a time.
  await row("Tailscale").click();
  await expect(devices).toHaveAttribute("aria-expanded", "false");
  await expect(section.getByRole("link", { name: "Open login.tailscale.com" })).toHaveAttribute("href", "https://login.tailscale.com/admin/machines");
  // Optional ones are the person's choice, and open the same way.
  await section.getByRole("button", { name: "Optional (1)" }).click();
  await expect(row("Codex")).toContainText("Your choice");
  await row("Codex").click();
  await expect(section).toContainText('npm install -g --prefix "$HOME/.npm-global" @openai/codex@latest');
  await noHorizontalOverflow(page);
  // Go there takes you to the section, in its own tab (Devices): last, as the checklist isn't in that one.
  await devices.click();
  await section.getByRole("button", { name: "Go there" }).click();
  await expect(page.getByRole("tab", { name: "Devices", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#devices")).toBeInViewport();
});

test("Check again asks the hub (and the agents) again", async ({ page }) => {
  let now = LEFT;
  const seen = await hub(page, { get: () => now, recheck: () => (now = ALL_DONE) });
  await page.goto("/#/settings");
  const section = page.locator(".agent-setup");
  await expect(section.getByRole("status")).toHaveText("3 of 6 done · 2 need you · 1 to do");
  await section.getByRole("button", { name: "Check again" }).click();
  await expect(section.getByRole("status")).toContainText("Everything needed is set up on");
  expect(seen).toContain("recheck");
});

test("with everything needed done it's one line, and the list opens when asked", async ({ page }) => {
  await hub(page, { get: () => ALL_DONE });
  await page.goto("/#/settings");
  const section = page.locator(".agent-setup");
  await expect(section.getByRole("status")).toContainText("Everything needed is set up on");
  await expect(section).not.toContainText(CLAUDE);
  await section.getByRole("button", { name: "Show the list" }).click();
  await expect(section.getByRole("status")).toHaveText("6 of 6 done");
  await expect(section).toContainText(CLAUDE);
  await expect(section.getByRole("button", { name: "Done (6)" })).toBeVisible();
});

test("an older hub says to update it; a check that failed says why, with Try again", async ({ page }) => {
  await hub(page, { get: () => ({ status: 404, error: "not found" }) });
  await page.goto("/#/settings");
  await expect(page.locator(".agent-setup")).toContainText("Update Crosstalk on");
  await expect(page.locator(".agent-setup")).toContainText("to see what's left to set up there.");
  await page.unrouteAll();

  let fail = true;
  await hub(page, { get: () => (fail ? { status: 500, error: "The checklist took too long." } : LEFT) });
  await page.reload();
  const section = page.locator(".agent-setup");
  await expect(section.getByRole("alert")).toContainText("The checklist took too long.");
  fail = false;
  await section.getByRole("button", { name: "Try again" }).click();
  await expect(section.getByRole("status")).toHaveText("3 of 6 done · 2 need you · 1 to do");
});

test("an older hub's message goes by itself once that hub is back, updated", async ({ page }) => {
  let updated = false;
  await hub(page, { get: () => (updated ? LEFT : { status: 404, error: "not found" }) });
  // The live connection is played, so the test can drop it the way a hub that restarts does.
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket("**/api/ws?**", (ws) => {
    sockets.push(ws);
    ws.onMessage((data) => {
      if (JSON.parse(String(data)).t === "ping") ws.send(JSON.stringify({ t: "pong" }));
    });
  });
  await page.goto("/#/settings");
  const section = page.locator(".agent-setup");
  await expect(section).toContainText("Update Crosstalk on");
  await expect.poll(() => page.evaluate(async (path) => (await import(path)).useStore.getState().status, "/src/store.ts")).toBe("open");
  // Past the load Settings makes once the agents' answers settle (1.5 s): from here only coming back loads it again.
  await page.waitForTimeout(2000);
  // Updated and restarted: its connection drops and opens again, and nothing reloads Settings for a linked machine.
  updated = true;
  sockets.at(-1)!.close({ code: 1001 });
  await expect.poll(() => sockets.length).toBeGreaterThan(1);
  await expect(section.getByRole("status")).toHaveText("3 of 6 done · 2 need you · 1 to do");
  await expect(section).not.toContainText("Update Crosstalk on");
});

test("Add for me runs the agent's own command in a terminal on the machine, for installed agents only", async ({ page }) => {
  const seen = await hub(page, { get: () => LEFT });
  page.on("dialog", (d) => void d.accept());
  await page.goto("/#/settings");
  const section = page.locator(".agent-setup");
  // Codex isn't installed there: only Claude Code has the button.
  await expect(section.getByRole("button", { name: "Add for me" })).toHaveCount(1);
  await section.getByRole("button", { name: "Add for me" }).click();
  const dialog = page.getByRole("dialog", { name: "Adding setup tools to Claude Code" });
  await expect(dialog).toBeVisible();
  // While it runs the dialog promises nothing about what the output will say.
  await expect(dialog).toContainText(/Claude Code's own command runs on .+\./);
  await expect(dialog).not.toContainText("Once it says crosstalk-setup was added");
  expect(seen).toContain("connect claude");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => seen).toContain("pty closed");
});

test("an agent that already had the setup tools reads as done, with the prompt to hand it; a real failure says what to run", async ({ page }) => {
  await catchCopies(page);
  // Claude Code refuses in red for a server that's already there, and exits 1 (as 2.1.289 does).
  let end = { exitCode: 1, output: "MCP server crosstalk-setup already exists in user config\r\n" };
  await hub(page, { get: () => LEFT, pty: () => end });
  page.on("dialog", (d) => void d.accept());
  await page.goto("/#/settings");
  const section = page.locator(".agent-setup");
  await section.getByRole("button", { name: "Add for me" }).click();
  const dialog = page.getByRole("dialog", { name: "Adding setup tools to Claude Code" });
  // What it refused over is a name in its config, which is all it compared: that is what the dialog says.
  await expect(dialog.getByRole("status")).toContainText("Claude Code already has an entry called crosstalk-setup.");
  await expect(dialog).toContainText("It printed that below, in its own words. Give Claude Code this prompt:");
  await expect(dialog).not.toContainText("Nothing else to do here");
  // Nothing in it reads as a failure, and the agent's own output is still on screen under it.
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.locator(".term-box")).toBeVisible();
  await noHorizontalOverflow(page);
  // The one thing left to do is right here.
  await dialog.getByRole("button", { name: "Copy the prompt" }).click();
  await expect.poll(() => copies(page)).toEqual([`${PROMPT} If you don't have those tools, run ${BIN} setup --json instead, and read http://127.0.0.1:7420/setup.md.`]);
  // And the way out if that entry is an older install's: remove it, then Add for me again.
  await expect(dialog).toContainText("If Claude Code answers that it hasn't got those tools");
  await dialog.getByRole("button", { name: "Copy the Claude Code remove command" }).click();
  await expect.poll(() => copies(page)).toHaveLength(2);
  expect((await copies(page))[1]).toBe("claude mcp remove crosstalk-setup -s user");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  // A command that really failed: what happened, and the command to run by hand.
  end = { exitCode: 1, output: "Error: EACCES: permission denied, open '/Users/me/.claude.json'\r\n" };
  await section.getByRole("button", { name: "Add for me" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Claude Code couldn't add the setup tools.");
  await expect(dialog).toContainText(/Run this yourself in a terminal on .+:/);
  await expect(dialog.getByRole("status")).toHaveCount(0);
  await noHorizontalOverflow(page);
  await dialog.getByRole("button", { name: "Copy the Claude Code command" }).click();
  await expect.poll(() => copies(page)).toHaveLength(3);
  expect((await copies(page))[2]).toBe(CLAUDE);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});

test("nothing is wider than the screen at 320 or 390 px, however long the commands", async ({ page }) => {
  const long = `/Users/someone-with-a-very-long-name/Applications/Crosstalk Release Folder/${"nested/".repeat(6)}crosstalk-hub`;
  const wide = { ...LEFT, connect: { ...LEFT.connect, claude: `claude mcp add --scope user crosstalk-setup -- '${long}' setup-mcp`, codex: `codex mcp add crosstalk-setup -- '${long}' setup-mcp` } };
  await hub(page, { get: () => wide });
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/#/settings");
    await expect(page.locator(".agent-setup")).toContainText(long);
    await page.locator(".agent-setup .as-row-btn", { hasText: "HTTPS address" }).click();
    await noHorizontalOverflow(page);
  }
});
