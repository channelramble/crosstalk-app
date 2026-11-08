import type { Page } from "@playwright/test";
import type { SetupChecklist, SetupItem } from "@crosstalk/shared";
import { test, expect, noHorizontalOverflow } from "./fixtures";

// Settings → Set up with an AI agent, the BrowserOS neo row (hub/src/setup/checklist.ts `browseros`, web
// agentSetup.ts, views/AgentSetupSection.tsx). The hub's checklist is played here, so this test never reads the real
// BrowserOS neo on the machine, never asks GitHub, and never installs anything: it is about what the phone shows.

const BIN = "/Users/me/.local/bin/crosstalk-hub";
const PROMPT = "Use the crosstalk-setup tools to finish setting up Crosstalk on this machine; ask me before anything that needs my password.";
/** The address the browser really answered on in the facts behind this list — never a port anyone assumed. */
const MCP_URL = "http://127.0.0.1:9010/mcp";
const RESTART = "The agent only picks up a new MCP server when it starts again, so close it and open it once after this.";
const CODEX_ADD = `codex mcp add browseros-neo --url ${MCP_URL}`;
const CLAUDE_ADD = `claude mcp add --scope user --transport http browseros-neo ${MCP_URL}`;

const item = (id: string, title: string, state: SetupItem["state"], over: Partial<SetupItem> = {}): SetupItem => ({ id, group: "hub", title, state, optional: false, detail: `${title}: what was found.`, fix: state === "done" ? null : { text: `How to fix ${title}.` }, ...over });

function checklist(browseros: SetupItem, connect: SetupChecklist["connect"]["browseros"]): SetupChecklist {
  const items = [item("service", "Runs as a service", "done"), item("agent.claude", "Claude Code", "done", { group: "agents" }), browseros];
  const req = items.filter((i) => !i.optional);
  const n = (s: string) => req.filter((i) => i.state === s).length;
  return {
    schema: 1,
    checkedAt: Date.now(),
    hub: { running: true, version: "0.6.1", name: "Mac mini", platform: "darwin", arch: "arm64", url: "https://mini.tail1.ts.net", localUrl: "http://127.0.0.1:7420", binary: BIN, service: "launchd", update: null },
    summary: { total: req.length, done: n("done"), missing: n("missing"), user: n("user"), unknown: n("unknown") },
    items,
    connect: { claude: `claude mcp add --scope user crosstalk-setup -- ${BIN} setup-mcp`, codex: `codex mcp add crosstalk-setup -- ${BIN} setup-mcp`, gemini: `gemini mcp add --scope user crosstalk-setup ${BIN} setup-mcp`, cli: `${BIN} setup --json`, guide: "http://127.0.0.1:7420/setup.md", prompt: PROMPT, browseros: connect },
  };
}

/** Installed and answering, Claude Code pointed at it, Codex not: the one thing left to do. */
const CONNECT = {
  url: MCP_URL,
  rows: [
    { agent: "claude" as const, name: "Claude Code", command: CLAUDE_ADD, connected: true },
    { agent: "codex" as const, name: "Codex", command: CODEX_ADD, connected: false },
  ],
  restart: RESTART,
};
const TO_CONNECT = checklist(
  item("browseros", "BrowserOS neo", "missing", {
    group: "agents",
    optional: true,
    detail: `BrowserOS neo 0.51.2.3 answers at ${MCP_URL}. Codex hasn't got it yet.`,
    fix: { text: `Add it to Codex as "browseros-neo". ${RESTART}`, command: CODEX_ADD, screen: "Settings → Set up with an AI agent", target: "agent-setup" },
  }),
  CONNECT,
);

/** Not installed: an update or an install is offered with what gets checked first, and no address is claimed. */
const NOT_INSTALLED = checklist(
  item("browseros", "BrowserOS neo", "missing", {
    group: "agents",
    optional: true,
    detail: "Not installed. The newest build for this machine is 0.51.2.3 (165 MB).",
    fix: { text: "Install it. Crosstalk checks the download against the SHA-256 GitHub reports, and on a Mac its signature and notarisation, before anything goes in /Applications:", command: `${BIN} browseros install`, screen: "Settings → Set up with an AI agent", target: "agent-setup" },
  }),
  null,
);

async function hub(page: Page, get: () => SetupChecklist) {
  await page.route((url) => url.pathname === "/api/setup", (r) => r.fulfill({ json: get() }));
  await page.route("**/api/setup/recheck", (r) => r.fulfill({ json: get() }));
}

async function catchCopies(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { copied: string[] };
    w.copied = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => void w.copied.push(text) } });
  });
}
const copies = (page: Page) => page.evaluate(() => (window as unknown as { copied: string[] }).copied);

/**
 * Settings → Set up with an AI agent, with the list open. With everything *needed* done the section folds to one line
 * — which is the case here on purpose: BrowserOS neo is optional, so it must never be what keeps that line away.
 */
async function openList(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/settings");
  const section = page.locator(".agent-setup");
  await expect(section.getByRole("status")).toContainText("Everything needed is set up");
  await section.getByRole("button", { name: "Show the list" }).click();
  return section;
}

test("BrowserOS neo is the person's choice, and opens to the command for the agent that hasn't got it", async ({ page }) => {
  await catchCopies(page);
  await hub(page, () => TO_CONNECT);
  // It never counts against the summary: Crosstalk works without it, so the section still says everything is set up.
  const section = await openList(page);
  await expect(section).toContainText("2 of 2 done");
  await section.getByRole("button", { name: "Optional (1)" }).click();
  const row = section.locator(".as-row-btn", { hasText: "BrowserOS neo" });
  await expect(row).toContainText("Your choice");
  await row.click();
  await expect(section).toContainText(`BrowserOS neo 0.51.2.3 answers at ${MCP_URL}. Codex hasn't got it yet.`);
  // What's left to do is above what's already done, and each agent's own command is there to copy.
  await expect(section).toContainText(RESTART);
  // Inside the open row, not the section's own "add the setup tools" step, which uses the same kind of row.
  const rows = section.locator(".as-fix .as-connect");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("Codex");
  await expect(rows.last()).toContainText("Claude Code · connected");
  await noHorizontalOverflow(page);
  await section.getByRole("button", { name: "Copy the Codex command for BrowserOS neo" }).click();
  await section.getByRole("button", { name: "Copy the Claude Code command for BrowserOS neo" }).click();
  await expect.poll(() => copies(page)).toEqual([CODEX_ADD, CLAUDE_ADD]);
});

test("with no address found, nothing invents one: only the install line the hub gave", async ({ page }) => {
  await catchCopies(page);
  await hub(page, () => NOT_INSTALLED);
  const section = await openList(page);
  await section.getByRole("button", { name: "Optional (1)" }).click();
  await section.locator(".as-row-btn", { hasText: "BrowserOS neo" }).click();
  await expect(section).toContainText("Not installed. The newest build for this machine is 0.51.2.3 (165 MB).");
  await expect(section).toContainText("checks the download against the SHA-256 GitHub reports");
  await expect(section).toContainText(`${BIN} browseros install`);
  // No MCP address anywhere: the hub found none, so the page claims none.
  await expect(section).not.toContainText(MCP_URL);
  await expect(section).not.toContainText(RESTART);
  await noHorizontalOverflow(page);
  await section.getByRole("button", { name: "Copy the command for BrowserOS neo" }).click();
  await expect.poll(() => copies(page)).toEqual([`${BIN} browseros install`]);
});
