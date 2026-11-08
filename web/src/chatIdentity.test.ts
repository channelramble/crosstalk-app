import { expect, test } from "bun:test";
import type { AgentAccount, Member, Room } from "@crosstalk/shared";
import { chatGroups, chatIdentity, chatService, SERVICE_COLOR, serviceGroup, serviceWhere, serviceWhereWords } from "./chatIdentity";

const account = (over: Partial<AgentAccount> = {}): AgentAccount => ({ provider: "codex", id: "default", label: "Main", signedIn: true, account: null, plan: null, authMethod: null, error: null, checkedAt: 0, ...over });
const endpoint = (id: string, label: string, baseUrl: string, models: string[]): AgentAccount =>
  account({ id, label, kind: "endpoint", plan: "Custom model", endpoint: { baseUrl, models, contextWindow: null, hasKey: false } });
const member = (over: Partial<Member> = {}): Member => ({
  id: "mb1",
  roomId: "r1",
  handle: "codex",
  provider: "codex",
  model: null,
  role: "",
  permissionMode: "ask",
  status: "idle",
  statusDetail: null,
  config: {},
  createdAt: 0,
  position: 0,
  ...over,
});
const room = (over: Partial<Room> = {}): Room => ({
  id: "r1",
  name: "Chat",
  cwd: "/work/app",
  mode: "direct",
  leadMemberId: null,
  maxHops: 0,
  rounds: 1,
  parallel: false,
  createdAt: 0,
  updatedAt: 0,
  archived: false,
  chat: { provider: "codex", origin: "web" },
  ...over,
});

const QWEN = endpoint("qwen1", "Qwen here", "http://127.0.0.1:8080", ["qwen3.8-9b", "qwen3.8-27b"]);
const VENICE = endpoint("ven1", "Venice", "https://api.venice.ai/api", ["venice-uncensored"]);
const accounts = { codex: account(), "codex:qwen1": QWEN, "codex:ven1": VENICE, "codex:key1": account({ id: "key1", label: "Work key", kind: "apikey" }) };

test("a chat on the agent's own sign-in is the agent; one on a service of yours is that service and its model", () => {
  const own = chatIdentity(room(), member({ model: "gpt-6.1-sol" }), accounts);
  expect([own.name, own.model, own.service, own.where, own.groupKey]).toEqual(["Codex", "gpt-6.1-sol", null, null, "codex"]);

  const service = chatIdentity(room(), member({ config: { account: "qwen1" }, model: "qwen3.8-27b" }), accounts);
  expect([service.name, service.model, service.where, service.groupKey]).toEqual(["Qwen here", "qwen3.8-27b", "local", "svc:codex:qwen1"]);
  expect(service.provider).toBe("codex"); // the agent that drives it: what the model lock and the helpers follow
  expect(service.color).toBe(SERVICE_COLOR.local);
  expect(service.service?.id).toBe("qwen1");

  // No model set: the service's own first one is what it runs.
  expect(chatIdentity(room(), member({ config: { account: "qwen1" } }), accounts).model).toBe("qwen3.8-9b");
  // An API key is billed per use but is still the agent's own model: not a service.
  expect(chatIdentity(room(), member({ config: { account: "key1" } }), accounts).name).toBe("Codex");
  expect(chatService(member({ config: { account: "key1" } }), accounts)).toBeNull();
  // A chat whose machine hasn't sent its members yet falls back to the agent, never to nothing.
  expect(chatIdentity(room(), undefined, accounts).name).toBe("Codex");
});

test("where a service runs, in plain words", () => {
  expect(serviceWhere(QWEN)).toBe("local");
  expect(serviceWhere(VENICE)).toBe("web");
  expect(serviceWhere(endpoint("l1", "By name", "http://localhost:8080", ["m"]))).toBe("local");
  // Only a loopback address is this machine: a name that merely starts with those digits is somebody else's server, and
  // saying "on this machine" about it would be a lie (and would make its replies look free).
  for (const host of ["127.0.0.1.nip.io", "127.evil.example", "localhost.example.com"]) expect(serviceWhere(endpoint("x", "Elsewhere", `http://${host}:8080`, ["m"]))).toBe("web");
  expect(serviceWhereWords(endpoint("x", "Elsewhere", "http://127.0.0.1.nip.io:8080", ["m"]), null)).toBe("127.0.0.1.nip.io:8080");
  expect(serviceWhereWords(QWEN, null)).toBe("on this machine");
  expect(serviceWhereWords(QWEN, "the Mac mini")).toBe("on the Mac mini");
  expect(serviceWhereWords(VENICE, "the Mac mini")).toBe("api.venice.ai");
});

test("the chat list keeps a group per service, beside the agents' own", () => {
  const groups = chatGroups([
    { identity: chatIdentity(room(), member({ config: { account: "ven1" } }), accounts), machine: "" },
    { identity: chatIdentity(room(), member(), accounts), machine: "" },
    { identity: chatIdentity(room(), member({ config: { account: "qwen1" } }), accounts), machine: "mini" },
    // A second chat on the same service doesn't make a second group.
    { identity: chatIdentity(room({ id: "r2" }), member({ config: { account: "qwen1" } }), accounts), machine: "mini" },
  ]);
  // The agents always, then this machine's services, then the online ones.
  expect(groups.map((g) => [g.key, g.title])).toEqual([
    ["claude", "Claude Code"],
    ["codex", "Codex"],
    ["svc:codex:qwen1", "Qwen here"],
    ["svc:codex:ven1", "Venice"],
  ]);
  expect(groups[2].machine).toBe("mini"); // New chat from its heading starts on the machine the service is on
  expect(groups[3].where).toBe("web");
  // Without any service chat, the list is just the agents'.
  expect(chatGroups([]).map((g) => g.key)).toEqual(["claude", "codex"]);
});

test("two services of one name, one under each agent, get headings you can tell apart", () => {
  // The model pool saves its account under both agents with the same name, every time it runs.
  const pool = { codex: endpoint("pc", "Model pool", "http://100.64.0.3:8080", ["pool-qwen3"]), claude: account({ provider: "claude", id: "pl", label: "Model pool", kind: "endpoint", plan: "Custom model", endpoint: { baseUrl: "http://100.64.0.3:8080", models: ["pool-qwen3"], contextWindow: null, hasKey: false } }) };
  const both = { "codex:pc": pool.codex, "claude:pl": pool.claude };
  const groups = chatGroups([
    { identity: chatIdentity(room(), member({ config: { account: "pc" } }), both), machine: "" },
    { identity: chatIdentity(room({ id: "r2", chat: { provider: "claude", origin: "web" } }), member({ provider: "claude", config: { account: "pl" } }), both), machine: "" },
  ]);
  // The agent is the whole difference between the two: the model lock, the helpers and the permissions are its.
  expect(groups.map((g) => [g.key, g.title, g.agent])).toEqual([
    ["claude", "Claude Code", "claude"],
    ["codex", "Codex", "codex"],
    ["svc:claude:pl", "Model pool · Claude Code", "claude"],
    ["svc:codex:pc", "Model pool · Codex", "codex"],
  ]);
  // One of a kind keeps its plain name.
  expect(chatGroups([{ identity: chatIdentity(room(), member({ config: { account: "pc" } }), both), machine: "" }]).map((g) => g.title)).toEqual(["Claude Code", "Codex", "Model pool"]);
});

test("a model of yours named after an agent doesn't leave the list with two groups of one name", () => {
  // Nothing stops a person calling a model server of theirs "Codex": the hub only refuses a name another *saved*
  // account already has, and an agent's own sign-in is called "Main", never "Codex". chatGroups holds its services up
  // against each other but never against the agents' own groups, so the list keeps two headings reading "Codex" —
  // and ChatSidebar's ServiceHeader puts what tells them apart only in the button's aria-label, not on screen.
  const named = { "codex:n1": endpoint("n1", "Codex", "http://127.0.0.1:8080", ["qwen3.8-9b"]) };
  const titles = chatGroups([{ identity: chatIdentity(room(), member({ config: { account: "n1" } }), named), machine: "" }]).map((g) => g.title);
  // Every heading says something of its own; how it's told apart (where it runs, say) is the wording's to choose.
  expect(new Set(titles).size).toBe(titles.length);
  expect(titles.filter((t) => t === "Codex")).toHaveLength(1);
});

test("two machines each running a model of one name get headings that say which machine", () => {
  // The same model name on two machines, both driven by Codex: the agent can't tell them apart, so where it runs does.
  const here = { "codex:q1": endpoint("q1", "qwen3-8b", "http://127.0.0.1:8080", ["qwen3-8b"]) };
  const there = { "codex:q2": endpoint("q2", "qwen3-8b", "http://127.0.0.1:8080", ["qwen3-8b"]) };
  const titles = chatGroups([
    { identity: chatIdentity(room(), member({ config: { account: "q1" } }), here), machine: "", machineName: "this Mac" },
    { identity: chatIdentity(room({ id: "r2" }), member({ id: "mb2", config: { account: "q2" } }), there), machine: "m_linux", machineName: "Linux box" },
  ]).map((g) => g.title);
  expect(new Set(titles).size).toBe(titles.length);
  expect(titles).toContain("qwen3-8b · on this Mac");
  expect(titles).toContain("qwen3-8b · on Linux box");
});

test("a service's group key can't be an agent's or the group chats'", () => {
  expect(serviceGroup("codex", "qwen1")).toBe("svc:codex:qwen1");
  for (const key of ["claude", "codex", "group"]) expect(serviceGroup("codex", "qwen1")).not.toBe(key);
});
