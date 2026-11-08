import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentAccount } from "@crosstalk/shared";

// A service's own row in Settings → AI services. It could be tested there and changed nowhere: the key a check says was
// refused ("Paste one in the key field") had no field anywhere near it, and nothing on the row said where to go.

// The app's store reads a few browser globals when it loads; give it just enough to import in a test.
const g = globalThis as Record<string, unknown>;
g.location ??= { hash: "", href: "http://test/", origin: "http://test" };
g.window ??= Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
g.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
g.navigator ??= { userAgent: "test" };
g.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: "visible", querySelector: () => null };
g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { ServiceRow } = await import("./views/AiServices");

/** The words on screen: tags stripped, entities read. */
const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#x2192;/g, "→").replace(/\s+/g, " ").trim();

const account = (over: Partial<AgentAccount> = {}): AgentAccount => ({
  provider: "codex",
  id: "default",
  label: "Main",
  kind: "signin",
  endpoint: null,
  signedIn: true,
  account: "you@example.com",
  plan: "Plus",
  authMethod: null,
  error: null,
  checkedAt: Date.now(),
  ...over,
});
const service = (over: Partial<AgentAccount> = {}): AgentAccount =>
  account({ id: "qwen1", label: "Qwen here", kind: "endpoint", account: null, plan: "Custom model", endpoint: { baseUrl: "http://127.0.0.1:8080", models: ["qwen3-8b"], contextWindow: 16_384, hasKey: true, protocol: "chat" }, ...over });
const row = (a: AgentAccount) => words(renderToStaticMarkup(createElement(ServiceRow, { account: a })));

test("a service you added can be changed on its own row, and says where it is removed", () => {
  const shown = row(service());
  expect(shown).toContain("Change");
  expect(shown).toContain("Change its address, key or models with Change. Remove it under Codex → Accounts below.");
  // Still testable and refreshable, as before.
  expect(shown).toContain("Test");
  expect(shown).toContain("Refresh models");
});

test("a service on either agent that runs only on services is changed and removed on its row, and moves to the other", () => {
  const on = (provider: AgentAccount["provider"], baseUrl: string) => service({ provider, label: "Refuseless", endpoint: { baseUrl, models: ["m"], contextWindow: null, hasKey: true, protocol: "chat" } });
  for (const shown of [row(on("opencode", "https://api.refuseless.com")), row(on("builtin", "https://api.refuseless.com")), row(on("opencode", "https://nano-gpt.com/api"))]) {
    expect(shown).toContain("Change its address, key or models with Change, or take it away with Remove.");
    expect(shown).toContain("Remove");
    expect(shown).toContain("Test");
  }
  expect(row(on("opencode", "https://api.refuseless.com"))).toContain("Run it with Crosstalk agent");
  // This store is empty, as on a hub older than OpenCode, which doesn't list it and can't move anything there.
  expect(row(on("builtin", "https://api.refuseless.com"))).not.toContain("Run it with OpenCode");
  // Only those two services, and only those two agents.
  expect(row(on("builtin", "https://api.deepseek.com"))).not.toContain("Run it with");
  expect(row(on("codex", "https://api.refuseless.com"))).not.toContain("Run it with");
  expect(row(on("codex", "https://api.refuseless.com"))).not.toContain("take it away with Remove");
});

test("a plan sign-in and an API key keep their own words, and no Change of their own", () => {
  // Nothing to fix while they work.
  expect(row(account())).not.toContain("below.");
  expect(row(account({ signedIn: false }))).toContain("Press Sign in under Codex below.");
  expect(row(account({ kind: "apikey", provider: "claude", plan: null, account: null, signedIn: false }))).toContain("Replace the key under Claude Code below.");
  // Their address and key aren't Crosstalk's to change: only a custom model has a Change here.
  expect(row(account({ signedIn: false }))).not.toContain("Refresh models");
});
