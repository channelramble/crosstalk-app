import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OPENCODE_VERSION, type AgentAccount, type ProviderStatus } from "@crosstalk/shared";

// What a service's row offers for moving it to OpenCode, by what the hub says of OpenCode. A hub older than OpenCode doesn't
// list it, and a version 1 is installed and can't run these chats: both used to leave the button on.

// The app's store reads a few browser globals when it loads; give it just enough to import in a test.
const g = globalThis as Record<string, unknown>;
g.location ??= { hash: "", href: "http://test/", origin: "http://test" };
g.window ??= Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
g.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
g.navigator ??= { userAgent: "test" };
g.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: "visible", querySelector: () => null };
g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { ServiceRow } = await import("./views/AiServices");
const { useStore } = await import("./store");
const { agentCanRun, openCodeUnusable } = await import("./services");

const WRONG = "OpenCode 1.19.5 is installed, and Crosstalk needs version 2. Press Install to get it.";
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const openCode = (over: Partial<ProviderStatus> = {}): ProviderStatus => ({ provider: "opencode", installed: true, signedIn: true, version: OPENCODE_VERSION, binPath: "/h/.npm-global/bin/opencode", account: null, plan: null, authMethod: "AI service", error: null, checkedAt: 1, ...over });
const wrong = openCode({ version: "1.19.5", signedIn: null, error: WRONG });
const missing = openCode({ installed: false, version: null, binPath: null, signedIn: null });
const refuseless: AgentAccount = { provider: "builtin", id: "s1", label: "Refuseless", kind: "endpoint", workspaceId: null, endpoint: { baseUrl: "https://api.refuseless.com", models: ["m"], contextWindow: null, hasKey: true, protocol: "chat" }, signedIn: true, account: null, plan: "Custom model", authMethod: null, error: null, checkedAt: 1 };

// A static draw reads the store's first state, so that's where the hub's answer goes.
const first = useStore.getInitialState();
const before = first.providers;
afterEach(() => Object.assign(first, { providers: before }));
const row = (status?: ProviderStatus) => {
  Object.assign(first, { providers: status ? { opencode: status } : {} });
  return renderToStaticMarkup(createElement(ServiceRow, { account: refuseless }));
};
/** The move's button: its tag, or undefined when there's none. */
const button = (html: string) => [...html.matchAll(/<button\b[^>]*>(?:(?!<\/button>).)*<\/button>/gs)].map((m) => m[0]).find((b) => b.includes("Run it with OpenCode"));

test("the right OpenCode: the button is on, with nothing to explain", () => {
  const html = row(openCode());
  expect(button(html)).toBeDefined();
  expect(button(html)).not.toContain("disabled");
  expect(words(html)).not.toContain("isn't installed");
  expect(words(html)).not.toContain("needs version 2");
});

test("OpenCode not installed: the button waits, and says why", () => {
  const html = row(missing);
  expect(button(html)).toContain("disabled");
  expect(words(html)).toContain("OpenCode isn't installed on this machine yet. Press Install under OpenCode below, then run it with OpenCode.");
});

test("a version 1: the button waits, in the hub's words rather than \"isn't installed\"", () => {
  const html = row(wrong);
  expect(button(html)).toContain("disabled");
  expect(words(html)).toContain(WRONG);
  expect(words(html)).not.toContain("isn't installed");
});

test("a hub that doesn't list OpenCode offers no move there at all", () => {
  expect(button(row())).toBeUndefined();
});

test("what can run a service: the rule the row, the Add sheet and New chat all use", () => {
  expect(agentCanRun("opencode", openCode())).toBe(true);
  expect(agentCanRun("opencode", missing)).toBe(false);
  expect(agentCanRun("opencode", wrong)).toBe(false);
  expect(openCodeUnusable("opencode", wrong)).toBe(WRONG);
  expect(openCodeUnusable("opencode", missing)).toBeNull();
  // Not asked yet: nothing is held up.
  expect(agentCanRun("opencode", undefined)).toBe(true);
  // Only OpenCode: another agent's `error` is about something else, such as a sign-in check that failed.
  const codex = openCode({ provider: "codex", error: "Couldn't check the sign-in." });
  expect(agentCanRun("codex", codex)).toBe(true);
  expect(openCodeUnusable("codex", codex)).toBeNull();
});
