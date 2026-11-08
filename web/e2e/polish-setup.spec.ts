// Setup: Settings → Set up with an AI agent (views/AgentSetupSection.tsx, agentSetup.ts) — the checklist, "Add for me"
// and its terminal dialog. The hub's checklist and the terminal are played in the page (as agentSetup.spec.ts does), so
// no `mcp add` ever runs on this machine and the shared test hub is left exactly as it was found.
//
// Every test below is EXPECTED TO FAIL on today's code; each says above it which line is wrong and why.
//
// None of them forces a viewport, so they run at every width the suite has (320 to 1440, Chromium and WebKit):
// `bunx playwright test e2e/polish-setup.spec.ts --project chromium-390` for a phone, `--project webkit-320` for the
// smallest screen, `--project chromium-1440` for a desktop. The two that matter most on a phone are the double tap on
// "Add for me" (a tap that looks like it did nothing invites a second one) and where the keyboard lands after
// "Check again" finishes the list.
import { test, expect } from "./fixtures";
import type { Page, WebSocketRoute } from "@playwright/test";
import type { PtyInfo, SetupChecklist, SetupItem } from "@crosstalk/shared";

const BIN = "/Users/me/.local/bin/crosstalk-hub";
const CLAUDE = `claude mcp add --scope user crosstalk-setup -- ${BIN} setup-mcp`;
const CODEX = `codex mcp add crosstalk-setup -- ${BIN} setup-mcp`;
const PROMPT = "Use the crosstalk-setup tools to finish setting up Crosstalk on this machine; ask me before anything that needs my password.";

const item = (id: string, title: string, state: SetupItem["state"], over: Partial<SetupItem> = {}): SetupItem => ({
  id,
  group: "hub",
  title,
  state,
  optional: false,
  detail: `${title}: what was found.`,
  fix: state === "done" ? null : { text: `How to fix ${title}.` },
  ...over,
});

function checklist(items: SetupItem[]): SetupChecklist {
  const req = items.filter((i) => !i.optional);
  const n = (s: string) => req.filter((i) => i.state === s).length;
  return {
    schema: 1,
    checkedAt: Date.now(),
    hub: { running: true, version: "0.6.1", name: "Mac mini", platform: "darwin", arch: "arm64", url: "https://mini.tail1.ts.net", localUrl: "http://127.0.0.1:7420", binary: BIN, service: "launchd", update: null },
    summary: { total: req.length, done: n("done"), missing: n("missing"), user: n("user"), unknown: n("unknown") },
    items,
    connect: { claude: CLAUDE, codex: CODEX, gemini: `gemini mcp add --scope user crosstalk-setup ${BIN} setup-mcp`, cli: `${BIN} setup --json`, guide: "http://127.0.0.1:7420/setup.md", prompt: PROMPT },
  };
}

/** Claude Code installed and signed in, Codex not installed: one "Add for me" button, as the section draws it. */
const LEFT = checklist([
  item("service", "Runs as a service", "done"),
  item("version", "Version", "done"),
  item("devices", "Paired devices", "user", { group: "devices", fix: { text: "Make a one-time code, then type it on the phone.", command: `${BIN} pair 15`, screen: "Settings → Devices → Pair a new device", target: "devices" } }),
  item("agent.claude", "Claude Code", "done", { group: "agents" }),
  item("agent.codex", "Codex", "missing", { group: "agents", optional: true, fix: { text: "Install it with OpenAI's official installer:", command: 'npm install -g --prefix "$HOME/.npm-global" @openai/codex@latest' } }),
]);

/**
 * The same machine, with Claude Code installed but its sign-in unreadable — `claude auth status` timed out, say. The
 * hub says so in plain words and the agent item is "unknown" (hub/src/setup/checklist.ts agentItems), which is a state
 * about the sign-in, not about whether the CLI is there.
 */
const SIGN_IN_UNKNOWN = checklist(
  LEFT.items.map((i) => (i.id === "agent.claude" ? item("agent.claude", "Claude Code", "unknown", { group: "agents", detail: "Claude Code 2.1.289 is installed; its sign-in couldn't be checked (it didn't answer in time).", fix: { text: "Check again: the recheck_agents tool, or Settings → AI services → Check." } }) : i)),
);

const ALL_DONE = checklist(LEFT.items.map((i) => (i.optional ? i : { ...i, state: "done" as const, fix: null })));

const pty = (id: string): PtyInfo => ({ id, title: "Add setup tools to Claude Code", command: CLAUDE, purpose: "install", provider: "claude", alive: true, exitCode: null, createdAt: Date.now() });

/**
 * The hub's answers for the setup section, each request noted: the checklist, Check again, "Add for me" (optionally
 * slow, the way a phone on a tailnet sees it) and the terminal it opens.
 */
async function hub(
  page: Page,
  opts: {
    get: () => SetupChecklist;
    recheck?: () => SetupChecklist;
    connectDelayMs?: number;
    /** What the terminal says when it is read: null means the read fails, as it does while the hub is restarting. */
    read?: () => { exitCode: number | null; output: string } | null;
  },
) {
  const seen: string[] = [];
  await page.route((url) => url.pathname === "/api/setup", (r) => r.fulfill({ json: opts.get() }));
  await page.route("**/api/setup/recheck", (r) => r.fulfill({ json: (opts.recheck ?? opts.get)() }));
  await page.route("**/api/setup/connect", async (r) => {
    const id = `pty_setup_${seen.filter((s) => s.startsWith("connect")).length + 1}`;
    seen.push(`connect ${id}`);
    if (opts.connectDelayMs) await new Promise((done) => setTimeout(done, opts.connectDelayMs));
    await r.fulfill({ json: pty(id) });
  });
  await page.route("**/api/pty/**", async (r) => {
    const id = new URL(r.request().url()).pathname.split("/").pop()!;
    if (r.request().method() === "DELETE") {
      seen.push(`closed ${id}`);
      return r.fulfill({ json: { ok: true } });
    }
    const end = opts.read?.();
    if (end === null) return r.fulfill({ status: 404, json: { error: "No such terminal" } });
    return r.fulfill({ json: { info: { ...pty(id), alive: !end, exitCode: end?.exitCode ?? null }, scrollback: end?.output ?? "" } });
  });
  return seen;
}

/** The section, with the checklist loaded. */
async function section(page: Page) {
  await page.goto("/#/settings/agent-setup");
  const card = page.locator(".agent-setup");
  await expect(card).toBeVisible();
  return card;
}

// EXPECTED TO FAIL. views/AgentSetupSection.tsx: the "Add for me" button (the one inside `connectRows(list).map`) has
// no `disabled`, and `addFor` sets `adding` only after `POST /api/setup/connect` comes back. So between the tap and the
// terminal opening — a whole round trip to the hub over the tailnet — the control looks untouched and stays live.
test("Add for me stops taking taps while it is starting the agent's own command", async ({ page }) => {
  await hub(page, { get: () => LEFT, connectDelayMs: 1500, read: () => null });
  const card = await section(page);
  const add = card.getByRole("button", { name: "Add for me" });
  await add.click();
  // Either off, or busy: what must not happen is a control that looks idle while it is working.
  await expect(add).toBeDisabled();
});

// EXPECTED TO FAIL. Same two lines: nothing holds the second tap, so the hub spawns a second `claude mcp add` in its
// own terminal (hub/src/setup/index.ts `Setup.connect` keeps no state and refuses nothing). `setAdding` then keeps only
// the second, so the first terminal is never shown and never closed — the dialog's Cancel only ends the one in
// `adding` — and it sits in the hub's terminal list until it exits. Should the first finish before the second reads the
// file, the dialog reports what the second printed: "already has an entry called crosstalk-setup", with the command to
// remove it, for an add the person has just this second asked for (measured with claude 2.1.289: a second `mcp add` of
// the same name prints "MCP server crosstalk-setup already exists in user config" and exits 1).
test("two taps on Add for me run the agent's own command once", async ({ page }) => {
  const seen = await hub(page, { get: () => LEFT, connectDelayMs: 1500, read: () => null });
  const card = await section(page);
  const add = card.getByRole("button", { name: "Add for me" });
  await add.click();
  await add.click({ force: true });
  await expect(page.getByRole("dialog", { name: "Adding setup tools to Claude Code" })).toBeVisible();
  expect(seen.filter((s) => s.startsWith("connect"))).toEqual(["connect pty_setup_1"]);
});

// Off while it starts, but not with the `disabled` attribute: a browser may drop the focus of a button it disables
// (WebKit does), and a keyboard or screen-reader user who pressed it is then left on the page itself. Closing the dialog
// that opens puts them back on it: its terminal takes the focus as it mounts, before ui.tsx's Dialog noted what had it,
// so the dialog used to give the focus back to nothing, and they were at the top of the page in every browser.
test("Add for me keeps the keyboard's place while it starts, and has it back when its dialog closes", async ({ page }) => {
  const seen = await hub(page, { get: () => LEFT, connectDelayMs: 1500, read: () => null });
  const card = await section(page);
  const add = card.getByRole("button", { name: "Add for me" });
  // Pressed with the keyboard: WebKit doesn't focus a button on a mouse click, so a tap would prove nothing here.
  await add.focus();
  await page.keyboard.press("Enter");
  await expect(add).toBeDisabled();
  await expect(add).toBeFocused();
  // Another press meanwhile starts nothing more.
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Adding setup tools to Claude Code" });
  await expect(dialog).toBeVisible();
  expect(seen.filter((s) => s.startsWith("connect"))).toEqual(["connect pty_setup_1"]);
  // Escape closes it; the command still runs, so it asks first, and stops it.
  page.once("dialog", (d) => void d.accept());
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(seen).toContain("closed pty_setup_1");
  await expect(add).toBeFocused();
});

// EXPECTED TO FAIL. agentSetup.ts `connectRows`: `installed` is `state === "done" || state === "user"`, so an agent
// that is installed but whose sign-in couldn't be checked ("unknown") is taken for one that isn't installed, and the
// one-tap path disappears — exactly when something is already a bit wrong. The hub would run it: POST
// /api/setup/connect only needs `providers.which(agent)` (hub/src/setup/index.ts Setup.connect).
test("Add for me is still offered when the agent is installed but its sign-in couldn't be checked", async ({ page }) => {
  await hub(page, { get: () => SIGN_IN_UNKNOWN, read: () => null });
  const card = await section(page);
  await expect(card).toContainText(CLAUDE);
  await expect(card.getByRole("button", { name: "Add for me" })).toHaveCount(1);
});

// EXPECTED TO FAIL. views/AgentSetupSection.tsx: when the list comes back all done, the whole `Checklist` (with the
// "Check again" button the person just pressed) is replaced by the one-line "Everything needed is set up" block.
// Nothing moves the keyboard, so focus falls back to <body>: a keyboard or screen-reader user is dropped at the top of
// the page, with no idea the check finished.
test("Check again that finishes the list leaves the keyboard inside the section", async ({ page }) => {
  let now = LEFT;
  await hub(page, { get: () => now, recheck: () => (now = ALL_DONE), read: () => null });
  const card = await section(page);
  const again = card.getByRole("button", { name: "Check again" });
  // Pressed with the keyboard: WebKit doesn't focus a button on a mouse click, so a tap would prove nothing here.
  await again.focus();
  await page.keyboard.press("Enter");
  await expect(card.getByRole("status")).toContainText("Everything needed is set up on");
  expect(await page.evaluate(() => !!document.activeElement?.closest(".agent-setup")), "the focus must stay in the setup card").toBe(true);
});

// EXPECTED TO FAIL. views/AgentSetupSection.tsx `Command`: the button carries a fixed `aria-label` ("Copy the …
// command"), and only its visible text changes to "Copied". An aria-label wins over the text, so the accessible name
// never changes and nothing is announced: a screen-reader user gets no sign that the command is on the clipboard,
// while a failure does say so (the toast). The app's own code-block copy button already does this right —
// `aria-label={copied === "yes" ? "Copied" : "Copy code"}` (ui.tsx) — so this is the one place out of step.
test("Copy says it copied to a screen reader, not only on screen", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => {} } });
  });
  await hub(page, { get: () => LEFT, read: () => null });
  const card = await section(page);
  const copy = card.getByRole("button", { name: "Copy the prompt" });
  await copy.click();
  await expect(card).toContainText("Copied");
  await expect(copy).toHaveAccessibleName(/copied/i);
});

// EXPECTED TO FAIL. views/AgentSetupSection.tsx: how the add ended is read only from its own `GET /api/pty/:id` poll,
// whose failures are swallowed ("nothing is claimed about how it went"), while the dialog's footer flips to "Done" from
// the exit code the app already has in `s.ptys[pty.id]`. So when that read can't get through — the hub restarting is
// the likeliest reason, and restarting is what the version item asks for — the dialog offers Done over a bare
// "Finished (exit 1)": no "already there", no failure, no command to run by hand.
test("the dialog says how the add ended even when the terminal can't be read again", async ({ page }) => {
  await hub(page, { get: () => LEFT, read: () => null });
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket("**/api/ws?**", (ws) => {
    sockets.push(ws);
    ws.onMessage((data) => {
      if (JSON.parse(String(data)).t === "ping") ws.send(JSON.stringify({ t: "pong" }));
    });
  });
  const card = await section(page);
  await card.getByRole("button", { name: "Add for me" }).click();
  const dialog = page.getByRole("dialog", { name: "Adding setup tools to Claude Code" });
  await expect(dialog).toBeVisible();
  // The hub says the command ended the way it says everything: one event on the live connection.
  await expect.poll(() => sockets.length).toBeGreaterThan(0);
  sockets.at(-1)!.send(JSON.stringify({ t: "pty", pty: { ...pty("pty_setup_1"), alive: false, exitCode: 1 } }));
  await expect(dialog.getByRole("button", { name: "Done" })).toBeVisible();
  // Claude Code exits 1 both for "already there" and for a real failure, so the dialog must say which, or at least
  // what to do next. Today it says neither.
  await expect(dialog.getByRole("status").or(dialog.getByRole("alert"))).toBeVisible();
});
