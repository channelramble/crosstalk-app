import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentAccount, Member, ModelOption, Provider, Room, UsageSnapshot } from "@crosstalk/shared";

// What a chat on an AI service and the Usage page say about it. The menu called the default compaction point "near full"
// while it compacts at 250,000 tokens on a 1M model, so sizes later than that looked earlier; and a service, which reports
// no limits to Crosstalk, was promised some ("Limits appear after the agent's first turn", "Not checked yet"), above real
// plans' cards.

// The app's store reads a few browser globals when it loads; give it just enough to import in a test.
const g = globalThis as Record<string, unknown>;
g.location ??= { hash: "", href: "http://test/", origin: "http://test" };
g.window ??= Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
g.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
g.navigator ??= { userAgent: "test" };
g.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: "visible", querySelector: () => null };
g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { ContextPop } = await import("./views/ChatControls");
const { UsageCard } = await import("./views/UsagePage");
const { usageCards } = await import("./usageWords");
const { useStore } = await import("./store");
const { accountKey } = await import("./accounts");

const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const options = (html: string) => [...html.matchAll(/<option[^>]*>([^<]*(?:<!-- -->[^<]*)*)<\/option>/g)].map((m) => m[1].replace(/<!-- -->/g, "").replace(/&#x27;/g, "'"));

const first = useStore.getInitialState();
const before = { accounts: first.accounts, usage: first.usage };
afterEach(() => Object.assign(first, before));

const room = { id: "r1", name: "Job", cwd: "/tmp/job", mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: 1000, updatedAt: 1000, archived: false, chat: { provider: "opencode", origin: "web" } } as unknown as Room;
const member = (provider: Provider, account = "svc1") => ({ id: "mb1", roomId: "r1", handle: provider, provider, model: "m", role: "", permissionMode: "full", status: "idle", statusDetail: null, config: { account }, createdAt: 1000, position: 0 }) as unknown as Member;
const service = (provider: Provider, label = "Refuseless"): AgentAccount => ({ provider, id: "svc1", label, kind: "endpoint", workspaceId: null, endpoint: { baseUrl: "https://api.refuseless.com", models: ["m"], contextWindow: null, hasKey: true, protocol: "chat" }, signedIn: true, account: null, plan: "Custom model", authMethod: "endpoint", error: null, checkedAt: 1 });
const signIn = (provider: Provider): AgentAccount => ({ provider, id: "default", label: "Main", kind: "signin", workspaceId: null, endpoint: null, signedIn: true, account: "me@example.com", plan: "Plan", authMethod: null, error: null, checkedAt: 1 });
const usageOf = (provider: Provider, id: string, windows: UsageSnapshot["windows"]): UsageSnapshot => ({ provider, accountId: id, plan: "Plan", account: null, windows, credits: null, note: null, updatedAt: 1 }) as unknown as UsageSnapshot;
const accountsOf = (...list: AgentAccount[]) => Object.fromEntries(list.map((a) => [accountKey(a.provider, a.id), a]));

const pop = (provider: Provider, model: Partial<ModelOption> | undefined, m = member(provider)) =>
  renderToStaticMarkup(createElement(ContextPop, { room, member: m, model: model as ModelOption | undefined, patch: async () => {}, onDone: () => {} }));
const compact = (provider: Provider, contextWindow: number | undefined, more: Partial<ModelOption> = {}) => options(pop(provider, contextWindow ? { id: "m", label: "M", efforts: [], contextWindow, ...more } : undefined));

test("the menu says where a chat on a service really compacts, and keeps offering the sizes past it", () => {
  const sizes = ["100k tokens", "200k tokens", "400k tokens", "600k tokens", "800k tokens"];
  expect(compact("opencode", 1_048_576)).toEqual(["OpenCode's default (250k)", ...sizes]);
  expect(compact("builtin", 1_048_576)).toEqual(["Crosstalk agent's default (250k)", ...sizes]);
  // Below about 333k it's three quarters of the window.
  expect(compact("opencode", 200_000)[0]).toBe("OpenCode's default (150k)");
  expect(compact("builtin", 200_000)[0]).toBe("Crosstalk agent's default (150k)");
});

test("an older machine's hub doesn't compact at that point, so the menu doesn't say so", () => {
  const hub = (first as { hub?: unknown }).hub;
  try {
    Object.assign(first, { hub: { version: "0.6.5" } });
    expect(compact("builtin", 1_048_576)[0]).toBe("Crosstalk agent's default (near full)");
    Object.assign(first, { hub: { version: "0.6.6" } });
    expect(compact("builtin", 1_048_576)[0]).toBe("Crosstalk agent's default (250k)");
  } finally {
    Object.assign(first, { hub });
  }
});

test("OpenCode keeps at least 16,000 tokens free, which comes first on a small window; with no room for that, it's still near full", () => {
  expect(compact("opencode", 48_000)[0]).toBe("OpenCode's default (32k)");
  expect(compact("builtin", 48_000)[0]).toBe("Crosstalk agent's default (36k)");
  expect(compact("opencode", 16_000)[0]).toBe("OpenCode's default (near full)");
});

test("no window known, or another agent: as it was", () => {
  expect(compact("opencode", undefined)[0]).toBe("OpenCode's default (near full)");
  expect(compact("claude", 1_000_000, { compactAt: 167_000 })[0]).toBe("Claude Code's default (167k)");
  expect(compact("claude", 1_000_000)[0]).toBe("Claude Code's default (near full)");
  expect(compact("codex", 272_000, { compactAt: 245_000 })[0]).toBe("Codex's default (245k)");
});

test("the context menu has no Plan limits on a service, unless it does report some", () => {
  Object.assign(first, { accounts: accountsOf(service("opencode")), usage: {} });
  const none = words(pop("opencode", undefined));
  expect(none).not.toContain("Plan limits");
  expect(none).not.toContain("Not checked yet");
  // Its name stays: it's what finds it on every screen.
  expect(pop("opencode", undefined)).toContain('aria-label="Context and plan limits"');

  Object.assign(first, { usage: { [accountKey("opencode", "svc1")]: usageOf("opencode", "svc1", [{ label: "Weekly", usedPercent: 12, resetsAt: null }]) } });
  expect(words(pop("opencode", undefined))).toContain("Plan limits");

  // A plan sign-in, or an account this device hasn't heard about, keeps what it had.
  Object.assign(first, { accounts: accountsOf(signIn("claude")), usage: {} });
  expect(words(pop("claude", undefined, member("claude", "default")))).toContain("Plan limits");
  expect(words(pop("claude", undefined, member("claude", "default")))).toContain("Not checked yet");
});

const NOW = 1000;
const card = (a: AgentAccount, u?: UsageSnapshot) => words(renderToStaticMarkup(createElement(UsageCard, { provider: a.provider, label: a.label, service: a.kind === "endpoint", u, now: NOW })));

test("Usage: plans first, then services, and no cards for the agents themselves", () => {
  const nano: AgentAccount = { ...service("builtin", "NanoGPT"), id: "svc2" };
  const accounts = accountsOf(service("opencode"), nano, signIn("codex"), signIn("claude"));
  // The hub reports both service-only agents as signed in: neither gets a card of its own for that.
  const hub = { builtin: { signedIn: true }, opencode: { signedIn: true }, claude: { signedIn: true }, codex: { signedIn: true } } as never;
  const shown = usageCards({}, accounts, hub).map((c) => c.key);
  expect(shown.slice(0, 4).map((key) => accounts[key]?.label)).toEqual(["Main", "Main", "Refuseless", "NanoGPT"]);
  expect(shown.slice(0, 2).every((key) => accounts[key]?.kind === "signin")).toBe(true);
  expect(shown.filter((key) => key === "opencode" || key === "builtin")).toEqual([]);
  // Only a service: it still has its card.
  expect(usageCards({}, accountsOf(service("opencode")), {}).map((c) => c.key)).toEqual([accountKey("opencode", "svc1")]);
});

test("a Usage card says what's true of its account", () => {
  const onService = card(service("opencode"));
  expect(onService).toContain("OpenCode · Refuseless");
  expect(onService).toContain("This service doesn't report limits to Crosstalk. What it costs is under Costs.");
  expect(onService).not.toContain("Limits appear after");
  expect(card(signIn("claude"))).toContain("Limits appear after the agent's first turn.");
  // What a hub did report goes first, on a service too.
  const reported = usageOf("opencode", "svc1", [{ label: "Weekly", usedPercent: 12, resetsAt: null }]);
  expect(card(service("opencode"), reported)).toContain("12% used");
  expect(card(service("opencode"), { ...reported, windows: [], note: "Its own note." })).toContain("Its own note.");
});
