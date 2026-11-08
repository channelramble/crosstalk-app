// Crosstalk's own agent and OpenCode beside signing agents in (signIn.ts, hubStore.ts, services.ts, usageWords.ts; the hub's
// side is hub/test/builtin-signin.test.ts). They have no sign-in: they run on an AI service's key. So no chat, Settings card,
// setup checklist item or notice ever offers to sign them in, whatever list a hub sends, and a key the service refused is
// said in the reply, with Open AI services, where the service's row checks the key for real. Where agents are listed
// (Settings → AI services' Agents line, Settings → Usage) they're listed as what they are: agents that run a service.
import { afterEach, expect, test } from "bun:test";
import {
  CHAT_PROVIDERS,
  NO_SIGN_IN_WORDS,
  PROVIDERS,
  SERVICE_ONLY_AGENTS,
  agentHasSignIn,
  isServiceKeyRefusal,
  noSignInWords,
  serviceKeyWords,
  signInNeededWords,
  staleSignInFailedWords,
  type AgentAccount,
  type Member,
  type ServerEvent,
  type SignInNeed,
} from "@crosstalk/shared";
import { PHONE_SIGN_IN, SHEET_ACTIONS, agentNeeds, chatNeeds, checklistAgent, sheetView, signInsShown } from "./signIn";
import { agentsLine, serviceFixLine, statusOf, testBody } from "./services";
import { usageCards } from "./usageWords";

const AT = Date.UTC(2026, 10, 1, 9, 40, 0);
const MACHINE = { id: "h_mini", name: "Mac mini" };
const REFUSED = "NanoGPT refused the key — check it in Settings → AI services, then tap Try again.";
const need = (over: Partial<SignInNeed> = {}): SignInNeed => ({ provider: "claude", account: "default", accountLabel: null, machine: MACHINE, since: AT, rooms: ["r1"], words: "Claude Code is signed out on Mac mini…", ...over });
/** What a hub would send if it ever said Crosstalk's agent was signed out (none does: SignIns.covers). */
const agentNeed = need({ provider: "builtin", account: "nano1", accountLabel: "NanoGPT", rooms: ["r2"], words: "Crosstalk agent (NanoGPT) is signed out…" });
const nanoMember = { provider: "builtin", config: { account: "nano1" } } as Pick<Member, "provider" | "config">;
const claudeMember = { provider: "claude", config: {} } as Pick<Member, "provider" | "config">;

test("only agents that have a sign-in are ever offered one: never the ones that run only on services", () => {
  // Every agent there is is here: a new kind of agent fails this until it says which it is.
  expect(Object.fromEntries(PROVIDERS.map((p) => [p, agentHasSignIn(p)]))).toEqual({ claude: true, codex: true, muse: true, antigravity: true, gemini: true, builtin: false, opencode: false, mock: false });
  // The phone's sheet signs in only agents that have one, and the chat agents always can be.
  expect(PHONE_SIGN_IN.every(agentHasSignIn)).toBe(true);
  for (const p of SERVICE_ONLY_AGENTS) expect(PHONE_SIGN_IN).not.toContain(p);
  expect(CHAT_PROVIDERS.every((p) => PHONE_SIGN_IN.includes(p))).toBe(true);
  // The setup checklist never has an item for it, and wouldn't offer a sign-in on one if it did.
  expect(checklistAgent({ id: "agent.builtin", state: "user" })).toBeNull();
  expect(checklistAgent({ id: "agent.opencode", state: "user" })).toBeNull();
  expect(checklistAgent({ id: "agent.claude", state: "user" })).toBe("claude");
});

test("a sign-in need for an agent that runs only on services, from any hub, shows nowhere: not in its chat, on a card or in the list", () => {
  const claude = need();
  const openCodeNeed = need({ provider: "opencode", account: "rl1", accountLabel: "Refuseless", rooms: ["r3"], words: "OpenCode (Refuseless) is signed out…" });
  const needs = [agentNeed, openCodeNeed, claude];
  expect(signInsShown(needs)).toEqual([claude]);
  // Its chat (and a chat on both) shows only the real one.
  const openCodeMember = { provider: "opencode", config: { account: "rl1" } } as Pick<Member, "provider" | "config">;
  for (const member of [nanoMember, openCodeMember]) {
    expect(chatNeeds(needs, [member])).toEqual([]);
    expect(chatNeeds(needs, [member, claudeMember])).toEqual([claude]);
  }
  // Settings → Agents has no card for it, and asked for its needs there are none.
  expect(agentNeeds(needs, "builtin")).toEqual([]);
  expect(agentNeeds(needs, "opencode")).toEqual([]);
  expect(agentNeeds(needs, "claude")).toEqual([claude]);
});

test("the sheet, if ever opened for it, says it has no sign-in and offers Open AI services, never a terminal", () => {
  const view = sheetView({ session: null, problem: { status: 409, code: "not_signin", message: NO_SIGN_IN_WORDS }, agent: "Crosstalk agent", machine: "Mac mini" });
  expect(view).toMatchObject({ phase: "problem", tone: "alert", words: NO_SIGN_IN_WORDS, actions: ["close", "settings"] });
  expect(view.actions.map((a) => SHEET_ACTIONS[a])).toEqual(["Close", "Open AI services"]);
  expect(view.words).not.toMatch(/terminal/i);
  // OpenCode's own answer, in its own name.
  const its = sheetView({ session: null, problem: { status: 409, code: "not_signin", message: noSignInWords("opencode") }, agent: "OpenCode", machine: "Mac mini" });
  expect(its).toMatchObject({ phase: "problem", words: "OpenCode has no sign-in: it runs on an AI service's key. Check that key in Settings → AI services.", actions: ["close", "settings"] });
});

test("a refused key in words: one sentence with where to fix it, told apart from every other failure", () => {
  expect(serviceKeyWords("NanoGPT")).toBe(REFUSED);
  expect(serviceKeyWords("NanoGPT", true)).toBe("NanoGPT needs a key — add it in Settings → AI services, then tap Try again.");
  // As the reply shows it, with the error mark; and as a hub before 0.6.7 says it, so a phone reading that hub's chats
  // offers Open AI services there too. OpenCode's reply says the same.
  const older = "NanoGPT refused the key. Check it in Settings → AI services, then try again.";
  expect([REFUSED, `⚠️ ${REFUSED}`, serviceKeyWords("Venice", true), older, `⚠️ ${older}`].map(isServiceKeyRefusal)).toEqual([true, true, true, true, true]);
  // Not a sign-in, money, a limit, the chat adapter's words for Codex, a model server's list, or nothing.
  for (const other of [
    signInNeededWords({ provider: "claude", account: "default" }, "Mac mini"),
    "NanoGPT says there isn't enough money in the account for deepseek: Insufficient balance. Add money on its website, or pick another model in this chat's settings (on NanoGPT, one its subscription covers).",
    "NanoGPT has had too many requests from this account just now. Wait a moment, then tap Try again.",
    "NanoGPT refused this key. Paste a working key in Settings → AI services, then try again.",
    "The server refused the key. Check it in this account's settings.",
    "",
    null,
    undefined,
  ])
    expect({ other, key: isServiceKeyRefusal(other) }).toEqual({ other, key: false });
  // Sign-in words asked for it anyway (nothing does): never "signed out", a sign-in that failed or a Sign in it doesn't
  // have, but its key's own words, which its reply shows with Open AI services.
  const asked = (["builtin", "opencode"] as const).flatMap((provider) => {
    const who = { provider, account: "nano1", accountLabel: "NanoGPT" };
    return [
      signInNeededWords(who, "Mac mini"),
      ...[null, true, false].map((signedIn) => staleSignInFailedWords(who, "Mac mini", { busy: false, signedIn })),
      staleSignInFailedWords(who, "Mac mini", { busy: true, signedIn: null }),
    ];
  });
  for (const words of asked) {
    expect(words).toBe(REFUSED);
    expect(words).not.toMatch(/\bsign(?:ed)? (?:in|out)\b|sign-in/i);
    expect(isServiceKeyRefusal(words)).toBe(true);
  }
  // Without the service's name it still says the key, never the agent's sign-in.
  expect(signInNeededWords({ provider: "builtin", account: "nano1" }, "Mac mini")).toBe("Its AI service refused the key — check it in Settings → AI services, then tap Try again.");
  // The agents that do sign in keep their words.
  expect(signInNeededWords({ provider: "claude", account: "default" }, "Mac mini")).toBe("Claude Code is signed out on Mac mini, so it couldn't answer. Sign in to it again (Settings → Agents → Claude Code → Sign in), then tap Try again.");
  expect(signInNeededWords({ provider: "gemini", account: "default" }, "Mac mini")).toBe("Gemini CLI is signed out on Mac mini, so it couldn't answer. Sign in to it again with Sign in in the chat, then tap Try again.");
});

test("Settings → AI services' Agents line: the agents that run on a service's key need no sign-in, and the sign-in there is Claude Code's and Codex's", () => {
  const nano = { provider: "builtin" as const, label: "NanoGPT" };
  const refuseless = { provider: "opencode" as const, label: "Refuseless" };
  const claude = { provider: "claude" as const, label: "Main" };
  expect(agentsLine([])).toBe("Claude Code and Codex run every service above. Install them, sign in to your plan or add accounts here.");
  expect(agentsLine([claude])).toBe("Claude Code and Codex run every service above. Install them, sign in to your plan or add accounts here.");
  expect(agentsLine([nano])).toBe("Crosstalk's own agent runs NanoGPT itself, with the key above: no sign-in, and no Claude Code or Codex needed. To use those too, install them, sign in to your plan or add accounts here.");
  expect(agentsLine([nano, { ...nano, label: "NanoGPT work" }])).toBe("Crosstalk's own agent runs NanoGPT and NanoGPT work itself, with the keys above: no sign-in, and no Claude Code or Codex needed. To use those too, install them, sign in to your plan or add accounts here.");
  expect(agentsLine([claude, nano])).toBe("Claude Code and Codex run the other services above. Crosstalk's own agent runs NanoGPT itself, with the key above, and needs no sign-in. Install Claude Code or Codex, sign in to your plan or add accounts here.");
  // Wherever "sign in to your plan" comes, Claude Code and Codex are named just before it, never Crosstalk's agent alone.
  expect(agentsLine([claude, refuseless])).toBe("Claude Code and Codex run the other services above. OpenCode runs Refuseless, with the key above, and needs no sign-in. Install Claude Code or Codex, sign in to your plan or add accounts here.");
  for (const list of [[nano], [claude, nano], [refuseless], [claude, refuseless], [refuseless, nano], [claude, refuseless, nano]]) {
    const line = agentsLine(list);
    const [before] = line.split("sign in to your plan");
    expect(before.split(". ").at(-1)).toMatch(/^(?:To use those too|Install Claude Code or Codex)/);
    expect(line).toContain("no sign-in");
  }
});

test("Settings → Usage: each agent's plan in the agents' order, then each service, and no card for an agent that has no plan of its own", () => {
  const usage = { claude: { provider: "claude" as const } };
  const accounts = {
    "builtin:nano1": { provider: "builtin" as const, id: "nano1", signedIn: true },
    "opencode:rl1": { provider: "opencode" as const, id: "rl1", signedIn: true },
    codex: { provider: "codex" as const, id: "default", signedIn: true },
    "claude:work": { provider: "claude" as const, id: "work", signedIn: true },
    "codex:old": { provider: "codex" as const, id: "old", signedIn: false },
  };
  const providers = { claude: { signedIn: true }, codex: { signedIn: true }, builtin: { signedIn: true }, opencode: { signedIn: true }, mock: { signedIn: true } };
  // Each service has its card, which says it reports no limits (UsageCard, web/src/serviceChat.test.tsx). The agents that
  // run them, which the hub reports as signed in, have none of their own.
  expect(usageCards(usage, accounts, providers)).toEqual([
    { key: "claude", provider: "claude" },
    { key: "claude:work", provider: "claude" },
    { key: "codex", provider: "codex" },
    { key: "builtin:nano1", provider: "builtin" },
    { key: "opencode:rl1", provider: "opencode" },
  ]);
  // Figures a hub sent for one (none does) don't put it ahead of Claude Code.
  expect(usageCards({ ...usage, "builtin:nano1": { provider: "builtin" } }, accounts, providers).map((c) => c.provider)).toEqual(["claude", "claude", "codex", "builtin", "opencode"]);
});

test("its service's row in Settings → AI services: Test checks the key for real, and nothing there says sign in, on either agent", () => {
  const nano: AgentAccount = {
    provider: "builtin",
    id: "nano1",
    label: "NanoGPT",
    kind: "endpoint",
    workspaceId: null,
    endpoint: { baseUrl: "https://nano-gpt.com/api", models: ["deepseek/deepseek-v4.1-flash-uncensored"], contextWindow: 1_048_576, hasKey: true, protocol: "chat" },
    signedIn: true,
    account: "https://nano-gpt.com/api",
    plan: "Custom model",
    authMethod: "endpoint",
    error: null,
    checkedAt: AT,
  };
  // The service check, by its account (the hub finds it under any agent): its key, at its address. Its account's own
  // check only ever says "ready", so a refused key would never show.
  expect(testBody(nano)).toEqual({ baseUrl: "https://nano-gpt.com/api", accountId: "nano1" });
  expect(testBody({ ...nano, provider: "opencode", id: "rl1" })).toEqual({ baseUrl: "https://nano-gpt.com/api", accountId: "rl1" });
  // Claude Code's and Codex's custom models still say which agent they're for.
  expect(testBody({ ...nano, provider: "codex", id: "c1" })).toEqual({ baseUrl: "https://nano-gpt.com/api", accountId: "c1", provider: "codex" });
  // The row's words: Change for its key, never Sign in, whatever its status says.
  for (const provider of SERVICE_ONLY_AGENTS)
    for (const signedIn of [true, false, null]) {
      const row = { ...nano, provider, signedIn };
      expect(serviceFixLine(row)).toBe("Change its address, key or models with Change, or take it away with Remove.");
      expect(statusOf(row, null, null).text).not.toMatch(/sign/i);
    }
});

// ---------------------------------------------------------------------------------------------- the store

const originals = new Map<string, PropertyDescriptor | undefined>();
function replace(key: string, value: unknown) {
  if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, value });
}
afterEach(() => {
  for (const [key, desc] of originals) {
    if (desc) Object.defineProperty(globalThis, key, desc);
    else Reflect.deleteProperty(globalThis, key);
  }
  originals.clear();
});

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (e: { data: string }) => void;
  constructor(public url: string) {
    Socket.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  event(e: ServerEvent) {
    this.onmessage?.({ data: JSON.stringify(e) });
  }
}

test("the app never keeps or announces a sign-in need for Crosstalk's agent, from the state or live", async () => {
  Socket.instances = [];
  replace("WebSocket", Socket);
  replace("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  replace("window", new EventTarget());
  replace("location", { origin: "http://localhost", href: "http://localhost/" });
  replace("navigator", { userAgent: "test" });
  const claude = need();
  const snapshot = { hub: { id: "h", name: "Mac mini" }, device: { id: "d", name: "Phone" }, rooms: [], members: [], approvals: [], usage: [], providers: [], accounts: [], storage: null, roomActivity: {}, signIns: [agentNeed, claude], signInSessions: [] };
  replace("fetch", async (url: string) => new Response(JSON.stringify(String(url).includes("/api/state") ? snapshot : {})));
  const heard: SignInNeed[] = [];
  const { createHubStore } = await import("./hubStore");
  const store = createHubStore({ baseUrl: "http://hub", token: "t", deviceName: "Phone" }, { toast() {}, openRoomId: () => null, roomGone() {}, signedOut() {}, approval() {}, ptyData() {}, signInNeeded: (n) => heard.push(n) });
  const going = store.getState().start();
  Socket.instances[0].open();
  await going;
  try {
    expect(store.getState().signIns).toEqual([claude]);
    // Live: a list with it in is kept without it, and it's never news (the global notice never offers to sign it in).
    const work = need({ account: "a_work", accountLabel: "Work" });
    Socket.instances[0].event({ t: "signin.needs", needs: [agentNeed, claude, need({ ...agentNeed, account: "nano2" }), work] });
    expect(store.getState().signIns).toEqual([claude, work]);
    expect(heard).toEqual([work]);
  } finally {
    store.getState().stop();
  }
});
