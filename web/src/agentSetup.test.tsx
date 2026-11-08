import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SetupChecklist, SetupItem } from "@crosstalk/shared";
import { STATE_WORDS, addOutcome, agentPrompt, allDone, browserosConnect, browserosNote, browserosRows, byState, connectRows, goThere, linkLabel, parts, removeCommand, stateWord, summaryText } from "./agentSetup";

// The app's store reads a few browser globals when it loads; give it just enough to import in a test.
const g = globalThis as Record<string, unknown>;
g.location ??= { hash: "", href: "http://test/", origin: "http://test" };
g.window ??= Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
g.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
g.navigator ??= { userAgent: "test" };
g.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: "visible", querySelector: () => null };
g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { AddResult, Checklist, ItemRow } = await import("./views/AgentSetupSection");

/** The words on screen: tags stripped, entities read. */
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const item = (id: string, state: SetupItem["state"], over: Partial<SetupItem> = {}): SetupItem => ({ id, group: "hub", title: id, state, optional: false, detail: `${id} detail`, fix: state === "done" ? null : { text: `${id} fix` }, ...over });
const BIN = "/Users/me/.local/bin/crosstalk-hub";
const list = (items: SetupItem[]): SetupChecklist => {
  const req = items.filter((i) => !i.optional);
  const n = (s: string) => req.filter((i) => i.state === s).length;
  return {
    schema: 1,
    checkedAt: Date.now(),
    hub: { running: true, version: "0.4.1", name: "Mac mini", platform: "darwin", arch: "arm64", url: "https://mini.tail1.ts.net", localUrl: "http://127.0.0.1:7420", binary: BIN, service: "launchd", update: null },
    summary: { total: req.length, done: n("done"), missing: n("missing"), user: n("user"), unknown: n("unknown") },
    items,
    connect: {
      claude: `claude mcp add --scope user crosstalk-setup -- ${BIN} setup-mcp`,
      codex: `codex mcp add crosstalk-setup -- ${BIN} setup-mcp`,
      gemini: `gemini mcp add --scope user crosstalk-setup ${BIN} setup-mcp`,
      cli: `${BIN} setup --json`,
      guide: "http://127.0.0.1:7420/setup.md",
      prompt: "Use the crosstalk-setup tools to finish setting up Crosstalk on this machine; ask me before anything that needs my password.",
    },
  };
};

const SAMPLE = list([
  item("service", "done"),
  item("version", "missing"),
  item("https", "unknown"),
  item("devices", "user", { title: "Paired devices", fix: { text: "Make a code.", command: `${BIN} pair 15`, screen: "Settings → Devices → Pair a new device", target: "devices" } }),
  item("agent.claude", "done", { group: "agents", title: "Claude Code" }),
  item("agent.codex", "missing", { group: "agents", title: "Codex", optional: true }),
  item("mac.autologin", "user", { group: "mac", title: "Starts again after a restart", fix: { text: "Turn on automatic login.", command: "/usr/bin/sudo /usr/sbin/sysadminctl -autologin set -userName me -password -", password: true, target: "this-mac" } }),
]);

test("what needs you comes first, then what an agent can do, then what couldn't be checked; optional and done apart", () => {
  const { left, optional, done } = parts(SAMPLE);
  expect(left.map((i) => i.id)).toEqual(["devices", "mac.autologin", "version", "https"]);
  expect(optional.map((i) => i.id)).toEqual(["agent.codex"]);
  expect(done.map((i) => i.id)).toEqual(["service", "agent.claude"]);
  expect(byState([item("a", "done"), item("b", "unknown"), item("c", "user")]).map((i) => i.id)).toEqual(["c", "b", "a"]);
  expect(STATE_WORDS).toEqual({ user: "Needs you", missing: "To do", unknown: "Not checked", done: "Done" });
  // What's only nice to have is the person's choice, not a to-do.
  expect(optional.map(stateWord)).toEqual(["Your choice"]);
  expect(stateWord(item("fda", "user", { optional: true }))).toBe("Your choice");
  expect(stateWord(item("fda", "unknown", { optional: true }))).toBe("Not checked");
  expect(stateWord(item("fda", "done", { optional: true }))).toBe("Done");
  expect(stateWord(item("devices", "user"))).toBe("Needs you");
});

test("the summary in a few words, and all done only when every needed item is", () => {
  expect(summaryText(SAMPLE)).toBe("2 of 6 done · 2 need you · 1 to do · 1 not checked");
  expect(summaryText(list([item("a", "done"), item("b", "user")]))).toBe("1 of 2 done · 1 needs you");
  expect(allDone(SAMPLE)).toBe(false);
  expect(allDone(list([item("a", "done"), item("b", "missing", { optional: true })]))).toBe(true);
});

test("the prompt is the one to give the agent, with where to look when it has no setup tools yet", () => {
  const p = agentPrompt(SAMPLE);
  expect(p.startsWith("Use the crosstalk-setup tools to finish setting up Crosstalk on this machine; ask me before anything that needs my password.")).toBe(true);
  expect(p).toContain(`run ${BIN} setup --json instead`);
  expect(p).toContain("http://127.0.0.1:7420/setup.md");
});

test("each agent's command, and Add for me only where that agent is installed", () => {
  expect(connectRows(SAMPLE)).toEqual([
    { agent: "claude", name: "Claude Code", command: SAMPLE.connect.claude, installed: true },
    { agent: "codex", name: "Codex", command: SAMPLE.connect.codex, installed: false },
  ]);
  // "unknown" is also an installed agent whose sign-in couldn't be checked: the machine's own word on its agents decides
  // that one, and only that one (a "missing" agent stays missing whatever anything else says).
  const unsure = list(SAMPLE.items.map((i) => (i.id === "agent.claude" ? { ...i, state: "unknown" as const } : i)));
  expect(connectRows(unsure).map((r) => r.installed)).toEqual([false, false]);
  expect(connectRows(unsure, { claude: false, codex: true }).map((r) => r.installed)).toEqual([false, false]);
  expect(connectRows(unsure, { claude: true, codex: true }).map((r) => r.installed)).toEqual([true, false]);
  expect(connectRows(SAMPLE, { claude: false }).map((r) => r.installed)).toEqual([true, false]);
  expect(goThere({ text: "", target: "this-mac" })).toBe("this-mac");
  expect(goThere({ text: "", target: "somewhere-else" })).toBeNull();
  expect(goThere(null)).toBeNull();
  expect(linkLabel("https://login.tailscale.com/admin/dns")).toBe("Open login.tailscale.com");
  expect(linkLabel("not a url")).toBe("Open the page");
});

const MCP_URL = "http://127.0.0.1:9010/mcp";
const RESTART = "The agent only picks up a new MCP server when it starts again, so close it and open it once after this.";
/** The checklist as a hub that found BrowserOS neo sends it: one agent connected, one not. */
const withBrowserOs = (): SetupChecklist => {
  const c = list([item("agent.claude", "done", { group: "agents", title: "Claude Code" }), item("browseros", "missing", { group: "agents", title: "BrowserOS neo", optional: true, detail: "BrowserOS neo 0.51.2.3 answers at " + MCP_URL + ". Codex hasn't got it yet.", fix: { text: "Add it to Codex. " + RESTART, command: "codex mcp add browseros-neo --url " + MCP_URL, screen: "Settings → Set up with an AI agent", target: "agent-setup" } })]);
  c.connect.browseros = {
    url: MCP_URL,
    rows: [
      { agent: "claude", name: "Claude Code", command: `claude mcp add --scope user --transport http browseros-neo ${MCP_URL}`, connected: true },
      { agent: "codex", name: "Codex", command: `codex mcp add browseros-neo --url ${MCP_URL}`, connected: false },
    ],
    restart: RESTART,
  };
  return c;
};

test("BrowserOS neo: what's left to connect comes first, and an older hub that sends none shows none", () => {
  const c = withBrowserOs();
  expect(browserosRows(c).map((r) => [r.agent, r.connected])).toEqual([
    ["codex", false],
    ["claude", true],
  ]);
  expect(browserosNote(c)).toBe(RESTART);
  // A hub that doesn't know about it, one that found no address, and one where every agent is already pointed at it.
  expect(browserosRows(SAMPLE)).toEqual([]);
  expect(browserosNote(SAMPLE)).toBeNull();
  expect(browserosConnect(SAMPLE)).toBeNull();
  const none = withBrowserOs();
  none.connect.browseros = { url: "", rows: [], restart: RESTART };
  expect(browserosConnect(none)).toBeNull();
  const all = withBrowserOs();
  all.connect.browseros!.rows = all.connect.browseros!.rows.map((r) => ({ ...r, connected: true }));
  expect(browserosNote(all)).toBeNull();
});

test("BrowserOS neo's row opens to the address it really answered on, and the command for each agent there", () => {
  const c = withBrowserOs();
  const open = words(renderToStaticMarkup(createElement(ItemRow, { item: c.items[1], list: c, open: true, onToggle: () => {} })));
  expect(open).toContain("BrowserOS neo");
  expect(open).toContain(MCP_URL);
  expect(open).toContain(`codex mcp add browseros-neo --url ${MCP_URL}`);
  expect(open).toContain("Claude Code · connected");
  expect(open).toContain(RESTART);
  // Closed, it is one line: a phone screen isn't filled with commands nobody asked to see.
  const shut = words(renderToStaticMarkup(createElement(ItemRow, { item: c.items[1], list: c, open: false, onToggle: () => {} })));
  expect(shut).not.toContain(MCP_URL);
  // No connect block: the fix's own command still shows, and nothing invents an address.
  const bare = words(renderToStaticMarkup(createElement(ItemRow, { item: c.items[1], open: true, onToggle: () => {} })));
  expect(bare).toContain(`codex mcp add browseros-neo --url ${MCP_URL}`);
  expect(bare).not.toContain("Claude Code · connected");
});

test("the list: both commands and the prompt with labelled Copy buttons, what's left by state, the rest folded", () => {
  const html = renderToStaticMarkup(createElement(Checklist, { list: SAMPLE, machine: "Mac mini", checking: false, onCheck: () => {}, onAdd: () => {} }));
  const text = words(html);
  expect(text).toContain("2 of 6 done · 2 need you · 1 to do · 1 not checked");
  expect(text).toContain("Add the setup tools to your agent on Mac mini, once");
  expect(text).toContain(SAMPLE.connect.claude);
  expect(text).toContain(SAMPLE.connect.codex);
  expect(text).toContain(agentPrompt(SAMPLE));
  for (const label of ["Copy the Claude Code command", "Copy the Codex command", "Copy the prompt"]) expect(html).toContain(`aria-label="${label}"`);
  // Codex isn't installed there: only Claude Code can be added for you.
  expect(html.match(/>Add for me</g)).toHaveLength(1);
  expect(text).toContain("What's left Needs you Paired devices Needs you Starts again after a restart To do version Not checked https");
  expect(text).toContain("Optional (1)");
  expect(text).toContain("Done (2)");
  expect(html).not.toContain("service detail");
  expect(text).toContain("Check again");
  expect(html).toContain('aria-label="What are setup tools?"');
  // Rows start closed, saying so.
  expect(html.match(/aria-expanded="false"/g)!.length).toBeGreaterThanOrEqual(4);
});

test("an open row: what was found, the fix with its command to copy, the password note, and where to go", () => {
  const autologin = SAMPLE.items.find((i) => i.id === "mac.autologin")!;
  const html = renderToStaticMarkup(createElement(ItemRow, { item: autologin, open: true, onToggle: () => {} }));
  const text = words(html);
  expect(html).toContain('aria-expanded="true"');
  expect(text).toContain("mac.autologin detail");
  expect(text).toContain("Turn on automatic login.");
  expect(text).toContain("/usr/bin/sudo /usr/sbin/sysadminctl -autologin set -userName me -password -");
  expect(html).toContain('aria-label="Copy the command for Starts again after a restart"');
  expect(text).toContain("It asks for your password: you type it yourself, never an agent.");
  expect(text).toContain("Go there");
  const tailscale = renderToStaticMarkup(createElement(ItemRow, { item: item("https", "user", { fix: { text: "Turn on HTTPS.", url: "https://login.tailscale.com/admin/dns" } }), open: true, onToggle: () => {} }));
  expect(tailscale).toContain('href="https://login.tailscale.com/admin/dns"');
  expect(words(tailscale)).toContain("Open login.tailscale.com");
  expect(words(tailscale)).not.toContain("Go there");
});

// ---- "Add for me": how the agent's own `mcp add` ended ----
// Each agent's real words, as the CLIs print them (Claude Code 2.1.289, Codex 0.160.0,
// Gemini CLI 0.62.0), each run twice against a throwaway HOME so none of the person's config was touched.
const CLAUDE_ADDED = "Added stdio MCP server crosstalk-setup with command: /Users/me/.local/bin/crosstalk-hub setup-mcp to user config\nFile modified: /Users/me/.claude.json";
const CLAUDE_ALREADY = "MCP server crosstalk-setup already exists in user config";
const CODEX_ADDED = "Added global MCP server 'crosstalk-setup'.";
const GEMINI_ADDED = 'MCP server "crosstalk-setup" added to user settings. (stdio)';
const GEMINI_ALREADY = 'MCP server "crosstalk-setup" is already configured within user settings.\nMCP server "crosstalk-setup" updated in user settings.';

test("an agent that already had the setup tools is read as done, whatever it calls it; words nobody knows stay a failure", () => {
  // Claude Code refuses, in red, with exit 1: already there, not a failure.
  expect(addOutcome("claude", 1, CLAUDE_ALREADY)).toBe("already");
  expect(addOutcome("claude", 1, "MCP server crosstalk-setup already exists in local config")).toBe("already");
  expect(addOutcome("claude", 1, "MCP server crosstalk-setup already exists in .mcp.json")).toBe("already");
  expect(addOutcome("claude", 0, CLAUDE_ADDED)).toBe("added");
  // Codex overwrites and says it added it, both times: its exit code alone says the tools are there.
  expect(addOutcome("codex", 0, CODEX_ADDED)).toBe("added");
  // Gemini CLI updates it and says it was already configured.
  expect(addOutcome("gemini", 0, GEMINI_ALREADY)).toBe("already");
  expect(addOutcome("gemini", 0, GEMINI_ADDED)).toBe("added");
  // A refusal in words nobody here knows is a plain failure, not a pretend success.
  expect(addOutcome("claude", 1, "Error: EACCES: permission denied, open '/Users/me/.claude.json'")).toBe("failed");
  expect(addOutcome("codex", 127, "zsh: command not found: codex")).toBe("failed");
  expect(addOutcome("gemini", 1, "Unknown arguments: scope, crosstalk-setup")).toBe("failed");
  // Stopped before it ended (no exit code): nothing is claimed.
  expect(addOutcome("claude", null, "")).toBe("failed");
  // "already" about something else doesn't make a run that worked read as already there.
  expect(addOutcome("codex", 0, "Already up to date.\nAdded global MCP server 'crosstalk-setup'.")).toBe("added");
  // Only its exit code came (what it printed couldn't be read): 0 says it worked; anything else could be either
  // "already there" or a failure for Claude Code, so it is neither.
  expect(addOutcome("claude", 0, null)).toBe("added");
  expect(addOutcome("claude", 1, null)).toBe("unread");
  expect(addOutcome("codex", null, null)).toBe("unread");
});

test("only Claude Code is offered a way to clear an entry that's already there, because only it refuses on the name", () => {
  expect(removeCommand("claude", SAMPLE.connect.claude)).toBe("claude mcp remove crosstalk-setup -s user");
  // Its own program name, whatever it is called or wherever it is (the command is the hub's, not this screen's).
  expect(removeCommand("claude", "/opt/homebrew/bin/claude mcp add --scope user crosstalk-setup -e CROSSTALK_HOME=/Users/me/hub -- /Users/me/.local/bin/crosstalk-hub setup-mcp")).toBe("/opt/homebrew/bin/claude mcp remove crosstalk-setup -s user");
  // Codex and Gemini overwrite the entry, so "already there" also means it is now the right one: nothing to remove.
  expect(removeCommand("codex", SAMPLE.connect.codex)).toBe(null);
  expect(removeCommand("gemini", SAMPLE.connect.gemini)).toBe(null);
  // No checklist to read the command from: no half-made command is offered.
  expect(removeCommand("claude", null)).toBe(null);
  expect(removeCommand("claude", "  ")).toBe(null);
});

test("the end of an add says plainly where it stands, and gives the one thing left to do", () => {
  const prompt = agentPrompt(SAMPLE);
  const render = (outcome: "added" | "already" | "failed", agent: "claude" | "codex" = "claude", name = "Claude Code") =>
    renderToStaticMarkup(createElement(AddResult, { outcome, agent, name, machine: "Mac mini", command: SAMPLE.connect[agent], prompt }));
  // Already there: done, with the prompt to hand the agent, and nothing that reads as an error. It says what the
  // agent actually told us — an entry of that name exists — not that the tools behind it are the right ones.
  const already = render("already");
  expect(words(already)).toContain("Claude Code already has an entry called crosstalk-setup.");
  expect(words(already)).toContain("It printed that below, in its own words. Give Claude Code this prompt:");
  expect(words(already)).toContain(prompt);
  expect(already).toContain('role="status"');
  expect(already).not.toContain("as-error");
  expect(already).toContain('aria-label="Copy the prompt"');
  // Nothing claims there is nothing left to check: an entry from an older install refuses exactly the same way.
  expect(words(already)).not.toContain("Nothing else to do here");
  expect(words(already)).toContain("If Claude Code answers that it hasn't got those tools, that entry is an older one: remove it, then use Add for me again.");
  expect(words(already)).toContain("claude mcp remove crosstalk-setup -s user");
  // Codex overwrites, so there is nothing stale to clear.
  const codex = render("already", "codex", "Codex");
  expect(words(codex)).toContain("Codex already has an entry called crosstalk-setup.");
  expect(words(codex)).not.toContain("mcp remove");
  // Added just now: the same end, and then there really is nothing else to do.
  const added = render("added");
  expect(words(added)).toContain("The setup tools are added to Claude Code.");
  expect(words(added)).toContain("Nothing else to do here. Give Claude Code this prompt:");
  expect(words(added)).not.toContain("mcp remove");
  expect(added).toContain('aria-label="Copy the prompt"');
  // It really failed: what happened, and the command to run by hand.
  const failed = render("failed");
  expect(failed).toContain('role="alert"');
  expect(words(failed)).toContain("Claude Code couldn't add the setup tools. What it printed is below.");
  expect(words(failed)).toContain("Run this yourself in a terminal on Mac mini:");
  expect(words(failed)).toContain(SAMPLE.connect.claude);
  expect(failed).toContain('aria-label="Copy the Claude Code command"');
  expect(words(failed)).not.toContain(prompt);
  // No checklist to read the command or prompt from (an older hub answered meanwhile): still no dead end.
  const bare = renderToStaticMarkup(createElement(AddResult, { outcome: "already" as const, agent: "codex" as const, name: "Codex", machine: "Mac mini", command: null, prompt: null }));
  expect(words(bare)).toContain("Codex already has an entry called crosstalk-setup.");
  expect(words(bare)).toContain("Close this and give Codex the prompt from the list.");
  // It ended without saying it worked and its output couldn't be read: neither "already" nor "failed" is claimed, and
  // the way to find out is right there.
  const unread = renderToStaticMarkup(createElement(AddResult, { outcome: "unread" as const, agent: "claude" as const, name: "Claude Code", machine: "Mac mini", command: SAMPLE.connect.claude, prompt }));
  expect(unread).toContain('role="alert"');
  expect(words(unread)).toContain("Claude Code's command ended without saying it worked, and what it printed couldn't be read from Mac mini. It may have found the setup tools already there, or not added them.");
  expect(words(unread)).toContain("To see which, run this yourself in a terminal on Mac mini:");
  expect(words(unread)).toContain(SAMPLE.connect.claude);
  expect(words(unread)).not.toContain("What it printed is below");
  expect(words(unread)).not.toContain("already has an entry");
  const unreadBare = renderToStaticMarkup(createElement(AddResult, { outcome: "unread" as const, agent: "codex" as const, name: "Codex", machine: "Mac mini", command: null, prompt: null }));
  expect(words(unreadBare)).toContain("To see which, close this and copy the Codex command from the list to run on Mac mini yourself.");
});

test("Add for me is off, and says it is busy, while the hub starts the command; only the agent tapped spins", () => {
  const html = renderToStaticMarkup(createElement(Checklist, { list: SAMPLE, machine: "Mac mini", checking: false, onCheck: () => {}, onAdd: () => {}, starting: "claude" }));
  const button = /<button[^>]*>(?:(?!<\/button>).)*Add for me<\/button>/.exec(html)![0];
  // Off with aria-disabled, never the `disabled` attribute: a browser drops the focus of a button it disables, and the
  // keyboard would lose its place (the second tap is refused by the section's addFor).
  expect(button).toContain('aria-disabled="true"');
  expect(button).not.toMatch(/^<button[^>]*\sdisabled[=\s>]/);
  expect(button).toContain('aria-busy="true"');
  expect(button).toContain("spin");
  const idle = renderToStaticMarkup(createElement(Checklist, { list: SAMPLE, machine: "Mac mini", checking: false, onCheck: () => {}, onAdd: () => {} }));
  const free = /<button[^>]*>(?:(?!<\/button>).)*Add for me<\/button>/.exec(idle)![0];
  expect(free).not.toContain("disabled");
  expect(free).not.toContain("aria-busy");
});
