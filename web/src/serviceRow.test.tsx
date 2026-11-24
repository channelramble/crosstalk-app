import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentAccount } from "@crosstalk/shared";

// An account's own row in Settings → Accounts: what it is, its state in words, and its own actions right there (it
// once said "Press Sign in under Codex below", a long scroll away from the button).

// The app's store reads a few browser globals when it loads; give it just enough to import in a test.
const g = globalThis as Record<string, unknown>;
g.location ??= { hash: "", href: "http://test/", origin: "http://test" };
g.window ??= Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
g.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
g.navigator ??= { userAgent: "test" };
g.document ??= { addEventListener() {}, removeEventListener() {}, visibilityState: "visible", querySelector: () => null };
g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { AccountRow } = await import("./views/AccountsList");

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
const row = (a: AgentAccount) => words(renderToStaticMarkup(createElement(AccountRow, { account: a })));

test("an account you added has its own actions on its row: nothing sends you to another card", () => {
  const shown = row(service());
  for (const action of ["Test", "Rename", "Remove", "Set a spending limit", "More", "Change", "Refresh models"]) expect(shown).toContain(action);
  // What it is and its state, in words.
  expect(shown).toContain("127.0.0.1:8080 · runs with Codex");
  expect(shown).toContain("Not tested yet");
  expect(shown).not.toContain("below");
});

test("a service on either agent that runs only on services is changed and removed on its row, and moves to the other", () => {
  const on = (provider: AgentAccount["provider"], baseUrl: string) => service({ provider, label: "Refuseless", endpoint: { baseUrl, models: ["m"], contextWindow: null, hasKey: true, protocol: "chat" } });
  for (const shown of [row(on("opencode", "https://api.refuseless.com")), row(on("builtin", "https://api.refuseless.com")), row(on("opencode", "https://nano-gpt.com/api"))]) {
    expect(shown).toContain("Change");
    expect(shown).toContain("Remove");
    expect(shown).toContain("Test");
  }
  expect(row(on("opencode", "https://api.refuseless.com"))).toContain("Run it with Crosstalk agent");
  // This store is empty, as on a hub older than OpenCode, which doesn't list it and can't move anything there.
  expect(row(on("builtin", "https://api.refuseless.com"))).not.toContain("Run it with OpenCode");
  // Only those two services, and only those two agents.
  expect(row(on("builtin", "https://api.deepseek.com"))).not.toContain("Run it with");
  expect(row(on("codex", "https://api.refuseless.com"))).not.toContain("Run it with");
});

test("a plan account and an API key say their state in words, with the way to fix it right there", () => {
  const signedIn = row(account());
  expect(signedIn).toContain("Signed in");
  // Signing out is there, under More; nothing to sign in to.
  expect(signedIn).toContain("Sign out");
  expect(signedIn).not.toContain("Sign in");
  const out = row(account({ signedIn: false }));
  expect(out).toContain("Not signed in");
  expect(out).toContain("Sign in");
  expect(out).not.toContain("below");
  // A plan isn't billed per use: no spending limit, and nothing of a server's.
  expect(out).not.toContain("spending limit");
  expect(out).not.toContain("Refresh models");
  const refused = row(account({ kind: "apikey", provider: "claude", plan: null, account: null, signedIn: false }));
  expect(refused).toContain("Key was refused");
  expect(refused).toContain("Key & workspace");
  expect(refused).toContain("Set a spending limit");
  // The main account stays: only an account you added can be removed.
  expect(row(account())).not.toContain("Remove");
  expect(row(account({ id: "work", label: "Work" }))).toContain("Remove");
});
