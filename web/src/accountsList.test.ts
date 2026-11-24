// Settings → Accounts as one list: every account under one heading, once; what its row says; its state in words.
import { expect, test } from "bun:test";
import { OPENCODE_VERSION, type AccountSpend, type AgentAccount, type ProviderStatus } from "@crosstalk/shared";
import { accountAbout, accountGroups, accountState, agentLine, canLimit, groupOf, isOwnServer, limitButton } from "./accountsList";

const account = (over: Partial<AgentAccount>): AgentAccount => ({ provider: "claude", id: "default", label: "Main", signedIn: true, account: null, plan: null, error: null, ...over }) as AgentAccount;
const endpoint = (provider: AgentAccount["provider"], id: string, label: string, baseUrl: string, over: Partial<AgentAccount> = {}) => account({ provider, id, label, kind: "endpoint", signedIn: null, endpoint: { baseUrl, models: ["m"], hasKey: true } as AgentAccount["endpoint"], ...over });
const keyed = (list: AgentAccount[]) => Object.fromEntries(list.map((a) => [`${a.provider}:${a.id}`, a]));

test("an address is your own when it's this machine, your home network or your tailnet", () => {
  for (const own of ["http://127.0.0.1:8080", "http://localhost:11434/v1", "http://[::1]:1234", "http://192.168.1.20:8080", "http://10.0.0.5", "http://172.20.1.1:80", "http://100.101.102.103:8080", "http://linux-box:8080", "http://studio.local:1234", "https://linux-box.tail1234.ts.net"]) expect(isOwnServer(own)).toBe(true);
  for (const theirs of ["https://api.moonshot.ai/v1", "https://openrouter.ai/api", "https://nano-gpt.com/api/v1", "https://api.deepseek.com", "http://8.8.8.8", "http://172.32.0.1", "http://100.128.0.1", "", undefined]) expect(isOwnServer(theirs)).toBe(false);
});

test("every account is listed once: under its agent, Other services, or Your own models", () => {
  const list = [
    account({ provider: "codex", id: "default", label: "Main" }),
    account({ provider: "claude", id: "work", label: "Work" }),
    account({ provider: "claude", id: "default", label: "Main" }),
    account({ provider: "claude", id: "key", label: "API key", kind: "apikey" }),
    endpoint("codex", "kimi", "Kimi", "https://api.moonshot.ai/v1"),
    endpoint("opencode", "nano", "NanoGPT", "https://nano-gpt.com/api/v1"),
    endpoint("builtin", "ref", "Refuseless", "https://api.refuseless.com/v1"),
    endpoint("claude", "qwen", "Qwen", "http://127.0.0.1:8080"),
    endpoint("codex", "box", "Linux box", "http://linux-box.tail1234.ts.net:8080"),
    // Agents Settings has no place for: not listed.
    account({ provider: "gemini", id: "default", label: "Main" }),
    endpoint("gemini", "x", "X", "https://example.com"),
  ];
  const groups = accountGroups(keyed(list));
  expect(groups.map((g) => [g.title, g.agent, g.accounts.map((a) => a.label)])).toEqual([
    // The agent's main account first, then the rest by name; its API keys are its own accounts.
    ["Claude Code", "claude", ["Main", "API key", "Work"]],
    ["Codex", "codex", ["Main"]],
    ["Other services", "opencode", ["Kimi", "NanoGPT", "Refuseless"]],
    ["Your own models", null, ["Linux box", "Qwen"]],
  ]);
  expect(groups.flatMap((g) => g.accounts).length).toBe(9);
  expect(groupOf(list[9])).toBeNull();
  // Every heading is there with nothing in it too.
  expect(accountGroups({}).map((g) => g.accounts.length)).toEqual([0, 0, 0, 0]);
});

test("a row says what the account is", () => {
  expect(accountAbout(account({ plan: "Claude Max", account: "me@example.com" }))).toBe("me@example.com");
  expect(accountAbout(account({ plan: "Claude Max", account: "me@example.com", signedIn: false }))).toBe("Claude Max · me@example.com");
  expect(accountAbout(account({}))).toBe("Your plan");
  expect(accountAbout(account({ kind: "apikey" }))).toBe("API key · billed per use");
  expect(accountAbout(endpoint("codex", "kimi", "Kimi", "https://api.moonshot.ai/v1"))).toBe("api.moonshot.ai · runs with Codex");
  expect(accountAbout(endpoint("opencode", "q", "Qwen", "http://127.0.0.1:8080"))).toBe("127.0.0.1:8080 · runs with OpenCode");
});

test("an account's state is said in words", () => {
  expect(accountState(account({ plan: "Claude Max" }), null, null)).toEqual({ tone: "ok", text: "Signed in · Claude Max" });
  expect(accountState(account({}), null, null)).toEqual({ tone: "ok", text: "Signed in" });
  expect(accountState(account({ signedIn: false }), null, null)).toEqual({ tone: "warn", text: "Not signed in" });
  expect(accountState(account({ signedIn: null }), null, null)).toEqual({ tone: "idle", text: "Sign-in not checked yet" });
  expect(accountState(account({ kind: "apikey" }), null, null)).toEqual({ tone: "ok", text: "Key works" });
  expect(accountState(account({ kind: "apikey", signedIn: false }), null, null)).toEqual({ tone: "bad", text: "Key was refused" });
  const kimi = endpoint("codex", "kimi", "Kimi", "https://api.moonshot.ai/v1");
  expect(accountState(kimi, null, null)).toEqual({ tone: "idle", text: "Not tested yet" });
  expect(accountState(kimi, { lines: [], problems: [], tone: "ok", text: "Reachable" }, null)).toEqual({ tone: "ok", text: "Key works" });
  expect(accountState(kimi, { lines: [], problems: [], tone: "bad", text: "Key refused" }, null)).toEqual({ tone: "bad", text: "Key was refused" });
  expect(accountState(kimi, { lines: [], problems: [], tone: "bad", text: "Can't reach it" }, null)).toEqual({ tone: "bad", text: "Can't reach it" });
  expect(accountState(kimi, null, { live: false } as never)).toEqual({ tone: "bad", text: "Can't reach it" });
  expect(accountState({ ...kimi, signedIn: false }, null, null)).toEqual({ tone: "bad", text: "Key was refused" });
  // A model of your own has no key to speak of.
  const own = endpoint("claude", "q", "Qwen", "http://127.0.0.1:8080");
  own.endpoint!.hasKey = false;
  expect(accountState(own, { lines: [], problems: [], tone: "ok", text: "Reachable" }, null)).toEqual({ tone: "ok", text: "Works" });
});

test("a spending limit is for an account billed per use", () => {
  const spend = (over: Partial<AccountSpend>) => ({ budget: null, ...over }) as AccountSpend;
  expect(canLimit(account({}), undefined)).toBe(false);
  expect(canLimit(account({ kind: "apikey" }), undefined)).toBe(true);
  expect(canLimit(endpoint("codex", "k", "Kimi", "https://api.moonshot.ai"), undefined)).toBe(true);
  expect(canLimit(endpoint("codex", "f", "Featherless", "https://api.featherless.ai"), spend({ flat: true }))).toBe(false);
  expect(limitButton(undefined)).toBe("Set a spending limit");
  expect(limitButton(spend({ budget: { state: "ok" } as AccountSpend["budget"] }))).toBe("Change spending limit");
  expect(limitButton(spend({ budget: { state: "stopped" } as AccountSpend["budget"] }))).toBe("Raise spending limit");
});

test("an agent is one line: its name, version and whether it's installed", () => {
  const st = (over: Partial<ProviderStatus>): ProviderStatus => ({ provider: "claude", installed: true, version: "2.1.330", binPath: "/bin/claude", signedIn: true, error: null, checkedAt: 1, ...over }) as ProviderStatus;
  expect(agentLine("claude", st({}))).toEqual({ text: "Claude Code 2.1.330 · installed", tone: "ok", action: null, note: null });
  expect(agentLine("codex", st({ provider: "codex", installed: false, version: null }))).toMatchObject({ text: "Codex · not installed", action: "Install" });
  expect(agentLine("claude", undefined).text).toBe("Claude Code · checking…");
  expect(agentLine("claude", st({ checkedAt: 0 })).action).toBeNull();
  // OpenCode says when Crosstalk was checked with another version.
  expect(agentLine("opencode", st({ provider: "opencode", version: OPENCODE_VERSION }))).toMatchObject({ text: `OpenCode ${OPENCODE_VERSION} · installed`, action: null });
  expect(agentLine("opencode", st({ provider: "opencode", version: "0.0.1" }))).toMatchObject({ text: "OpenCode 0.0.1 · other version", action: "Update" });
  expect(agentLine("opencode", st({ provider: "opencode", installed: false, version: null }))).toMatchObject({ action: "Install", note: "Install it to run a service with it." });
});
