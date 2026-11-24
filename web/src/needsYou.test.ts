// Settings → Needs you: one row per thing only the person can do, each with a button; nothing when nothing does.
import { expect, test } from "bun:test";
import type { AgentAccount, ProviderStatus, SetupChecklist, SetupItem, SignInNeed } from "@crosstalk/shared";
import { needsYou, type NeedsInput } from "./needsYou";
import { pageLine, type IndexFacts } from "./settingsIndex";

const status = (provider: "claude" | "codex", over: Partial<ProviderStatus> = {}): ProviderStatus => ({ provider, installed: true, version: "1.0", binPath: `/bin/${provider}`, signedIn: true, account: null, plan: null, error: null, checkedAt: 1, ...over }) as ProviderStatus;
const item = (id: string, state: SetupItem["state"], over: Partial<SetupItem> = {}): SetupItem => ({ id, group: "hub", title: id, state, optional: false, detail: `${id} detail`, fix: null, ...over });
const list = (items: SetupItem[]) => ({ items }) as SetupChecklist;
const input = (over: Partial<NeedsInput> = {}): NeedsInput => ({ machine: "Mac mini", providers: { claude: status("claude"), codex: status("codex") }, accounts: {}, signIns: [], macDialogs: [], list: null, ...over });

test("nothing needs you when the agents are ready and the checklist is done", () => {
  expect(needsYou(input())).toEqual([]);
  expect(needsYou(input({ list: list([item("service", "done"), item("browseros", "missing", { optional: true, fix: { text: "x", target: "agent-setup" } })]) }))).toEqual([]);
});

test("an agent that's installed but signed out gets Sign in; one that isn't installed gets Install only while no agent is ready", () => {
  const out = needsYou(input({ providers: { claude: status("claude"), codex: status("codex", { signedIn: false }) } }));
  expect(out.map((n) => [n.id, n.button])).toEqual([["signin.codex.default", "Sign in"]]);
  expect(out[0].title).toBe("Codex isn't signed in");
  expect(out[0].action).toEqual({ kind: "signin", provider: "codex", account: "default", accountLabel: null });
  // Codex missing while Claude Code is ready: your choice, not a need.
  expect(needsYou(input({ providers: { claude: status("claude"), codex: status("codex", { installed: false, signedIn: false }) } }))).toEqual([]);
  // Neither ready: both are offered, each with what it needs.
  const none = needsYou(input({ providers: { claude: status("claude", { installed: false, signedIn: false }), codex: status("codex", { signedIn: false }) } }));
  expect(none.map((n) => [n.id, n.button])).toEqual([["install.claude", "Install"], ["signin.codex.default", "Sign in"]]);
  // Signed in through another of its accounts: nothing to do.
  const work = { "claude:work": { provider: "claude", id: "work", label: "Work", signedIn: true } as AgentAccount };
  expect(needsYou(input({ providers: { claude: status("claude", { signedIn: false }), codex: status("codex") }, accounts: work }))).toEqual([]);
  // Not checked yet: nothing is claimed.
  expect(needsYou(input({ providers: { claude: status("claude", { checkedAt: 0, signedIn: false }), codex: status("codex") } }))).toEqual([]);
});

test("an account a chat's reply stopped on comes first among the sign-ins, once", () => {
  const need: SignInNeed = { provider: "claude", account: "default", accountLabel: null, machine: { id: "m", name: "Mac mini" }, since: 1, rooms: ["a", "b"], words: "" };
  const out = needsYou(input({ providers: { claude: status("claude", { signedIn: false }), codex: status("codex") }, signIns: [need] }));
  expect(out.map((n) => n.id)).toEqual(["signin.claude.default"]);
  expect(out[0].detail).toBe("2 chats stopped on it and can't answer until it's signed in again.");
  const named = needsYou(input({ signIns: [{ ...need, account: "work", accountLabel: "Work", rooms: [] }] }));
  expect(named[0].title).toBe("Claude Code · Work isn't signed in");
});

test("a question on the Mac's screen is first, with See it", () => {
  const out = needsYou(input({ macDialogs: [{ id: "1", app: "Terminal", wants: "files on external drives", since: 1, count: 1 }, { id: "2", app: "adb", wants: "the network", since: 2, count: 1 }], providers: { claude: status("claude"), codex: status("codex", { signedIn: false }) } }));
  expect(out[0]).toMatchObject({ id: "mac.dialogs", title: "Mac mini is waiting for an answer on its screen", detail: "Terminal wants files on external drives, and 1 more.", button: "See it", action: { kind: "show", section: "this-mac" } });
  expect(out[1].id).toBe("signin.codex.default");
});

test("the checklist's other items show only when there's a place in Settings to do them: never a command", () => {
  const out = needsYou(
    input({
      list: list([
        item("https", "user", { fix: { text: "Turn on HTTPS.", command: "tailscale serve", url: "https://login.tailscale.com" } }),
        item("mac.autologin", "user", { title: "Starts again after a restart", fix: { text: "Turn on automatic login.", command: "sudo …", target: "this-mac" } }),
        item("push", "missing", { title: "Notifications", detail: "No device gets notifications yet. They need the https address first (above).", fix: { text: "Turn them on.", target: "notifications" } }),
        item("version", "missing", { fix: { text: "Restart.", command: "restart.sh" } }),
        item("agent.claude", "user", { fix: { text: "Sign in.", target: "agent-claude" } }),
        item("mac.dialogs", "user", { fix: { text: "Answer.", target: "this-mac" } }),
        item("odd", "user", { fix: { text: "Go.", target: "no-such-section" } }),
      ]),
    }),
  );
  expect(out.map((n) => [n.id, n.title, n.button, n.action])).toEqual([
    ["mac.autologin", "Starts again after a restart", "See it", { kind: "show", section: "this-mac" }],
    ["push", "Notifications", "See it", { kind: "show", section: "notifications" }],
    ["version", "Crosstalk update", "See it", { kind: "show", section: "advanced" }],
  ]);
  for (const n of out) expect(JSON.stringify(n)).not.toContain("sudo");
});

const facts = (over: Partial<IndexFacts> = {}): IndexFacts => ({ accounts: {}, usage: {}, spend: null, settings: null, templates: null, machines: ["Mac mini"], storage: null, imageEditor: null, notifications: null, zoom: 100, ...over });

test("each page's line says its state when the app knows it, else what's in it", () => {
  expect(pageLine("accounts", facts())).toBe("Plans, API keys, your own models");
  const accounts = {
    claude: { provider: "claude", id: "default", label: "Main", signedIn: true } as AgentAccount,
    codex: { provider: "codex", id: "default", label: "Main", signedIn: false } as AgentAccount,
    "codex:kimi": { provider: "codex", id: "kimi", label: "Kimi", kind: "endpoint", signedIn: null } as AgentAccount,
    "gemini": { provider: "gemini", id: "default", label: "Main", signedIn: false } as AgentAccount,
  };
  expect(pageLine("accounts", facts({ accounts }))).toBe("2 working · 1 not signed in");
  expect(pageLine("new-chats", facts({ templates: 2 }))).toBe("The model, effort and permissions a new chat starts with · 2 templates");
  expect(pageLine("together", facts())).toBe("Who does helper work, quick questions, reaching your other chats");
  expect(pageLine("together", facts({ settings: { teamwork: { enabled: true, perReply: 1, skipAbovePercent: 80, helper: {} }, agentsAcrossChats: false } }))).toBe("Quick questions on · Reaching other chats off");
  expect(pageLine("usage", facts())).toBe("Plan limits, what each account cost, spending limits");
  const usage = { claude: { provider: "claude", accountId: "default", windows: [{ label: "5-hour", usedPercent: 12, resetsAt: null }, { label: "Weekly", usedPercent: 43.4, resetsAt: null }], updatedAt: 1 } } as unknown as IndexFacts["usage"];
  expect(pageLine("usage", facts({ usage }))).toBe("Weekly 43% used");
  expect(pageLine("device", facts({ notifications: false, zoom: 110 }))).toBe("Notifications off · Text size 110%");
  expect(pageLine("device", facts())).toBe("Text size 100%");
  expect(pageLine("machines", facts({ machines: ["Mac mini", "Linux box"], storage: { total: 500 * 1024 ** 3, free: 212.4 * 1024 ** 3, reserve: 0, low: false } }))).toBe("Mac mini and Linux box · 212 GB free");
  expect(pageLine("machines", facts({ machines: ["A", "B", "C"] }))).toBe("3 machines");
  expect(pageLine("models", facts())).toBe("Models that run on your machines, and the image editor");
  expect(pageLine("models", facts({ imageEditor: { installed: true, state: "off" } }))).toBe("Image editor off");
  expect(pageLine("models", facts({ imageEditor: { installed: false, state: "off" } }))).toBe("Models that run on your machines, and the image editor");
});

test("what the checklist says of an item above it in its own list is left out", () => {
  const out = needsYou(input({ list: list([item("push", "user", { detail: "No device gets notifications yet, so approvals don't reach you. They need the https address first (above).", fix: { text: "x", target: "notifications" } })]) }));
  expect(out[0].detail).toBe("No device gets notifications yet, so approvals don't reach you.");
});
