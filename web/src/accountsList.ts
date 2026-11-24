// Settings → Accounts as one list: which heading an account goes under, what its row says it is, and its state in
// words. Pure, for the unit tests; views/AccountsList.tsx draws it. (services.ts holds what a check found and what the
// Add sheet sends; this is only the list.)
import { CHAT_PROVIDERS, PROVIDER_INFO, isServiceOnlyAgent, type AccountSpend, type AgentAccount, type ChatProvider, type ModelCatalog, type Provider, type ProviderStatus } from "@crosstalk/shared";
import { openCodeState, type Outcome, type Tone } from "./services";

/** The list's headings, in order: each agent's own accounts, then the services, then your own models. */
export type AccountGroupId = ChatProvider | "services" | "own";

export interface AccountGroup {
  id: AccountGroupId;
  title: string;
  /** The agent whose line (installed, version, Install or Update) sits above the group's accounts. */
  agent: Provider | null;
  accounts: AgentAccount[];
}

const hostOf = (url: string | undefined): string => {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
};

/**
 * Whether an address is a computer of your own rather than a company's service: this machine, one on your home
 * network or tailnet, or a bare name. Those accounts are "your own models"; anything else is a service you pay.
 */
export function isOwnServer(baseUrl: string | undefined): boolean {
  const host = hostOf(baseUrl).replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host === "localhost" || host === "::1" || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".ts.net") || !host.includes(".")) return true;
  const ip = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!ip) return false;
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  // Loopback, home networks, and Tailscale's own range.
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}

/** Which heading an account goes under; null for one Settings doesn't list (an agent with no place here). */
export function groupOf(a: AgentAccount): AccountGroupId | null {
  const chat = (CHAT_PROVIDERS as readonly string[]).includes(a.provider);
  if (a.kind === "endpoint") {
    if (!chat && !isServiceOnlyAgent(a.provider)) return null;
    return isOwnServer(a.endpoint?.baseUrl) ? "own" : "services";
  }
  // A plan sign-in or an API key is the agent's own account.
  return chat ? (a.provider as ChatProvider) : null;
}

/**
 * The whole list: Claude Code, Codex, Other services, Your own models. Within a group the agent's main account comes
 * first, then the rest by name. Every group is there even when empty, so its heading (and the agent's line, and what
 * was found on this machine) has a place.
 */
export function accountGroups(accounts: Record<string, AgentAccount>): AccountGroup[] {
  const groups: AccountGroup[] = [
    ...CHAT_PROVIDERS.map((p) => ({ id: p as AccountGroupId, title: PROVIDER_INFO[p].name, agent: p as Provider, accounts: [] as AgentAccount[] })),
    { id: "services", title: "Other services", agent: "opencode", accounts: [] },
    { id: "own", title: "Your own models", agent: null, accounts: [] },
  ];
  for (const a of Object.values(accounts)) groups.find((g) => g.id === groupOf(a))?.accounts.push(a);
  for (const g of groups) g.accounts.sort((x, y) => Number(y.id === "default") - Number(x.id === "default") || x.label.localeCompare(y.label));
  return groups;
}

/**
 * What an account is, under its name: a plan's email (and the plan, until its state says it), an API key, or where a service or a model of
 * your own answers and which agent runs it (they're not under an agent's heading, so the row says).
 */
export function accountAbout(a: AgentAccount): string {
  const agent = PROVIDER_INFO[a.provider].name;
  if (a.kind === "apikey") return "API key · billed per use";
  if (a.kind === "endpoint") {
    let where = a.endpoint?.baseUrl ?? "";
    try {
      where = new URL(where).host;
    } catch {
      /* as entered */
    }
    return [where, `runs with ${agent}`].filter(Boolean).join(" · ");
  }
  // Signed in, its plan is said with its state ("Signed in · Claude Max"): here, whose it is.
  return [a.signedIn ? null : a.plan, a.account].filter(Boolean).join(" · ") || "Your plan";
}

/**
 * An account's state in words, with its dot: "Signed in · Claude Max", "Not signed in", "Key works", "Key was
 * refused". A service or a model of your own shows what its last Test found, else what's known without one.
 */
export function accountState(a: AgentAccount, outcome: Outcome | null, catalog: ModelCatalog | null): { tone: Tone; text: string } {
  if (a.kind === "apikey") return a.signedIn === true ? { tone: "ok", text: "Key works" } : a.signedIn === false ? { tone: "bad", text: "Key was refused" } : { tone: "idle", text: "Key not checked yet" };
  if (a.kind === "endpoint") {
    if (outcome) {
      if (outcome.text === "Key refused") return { tone: "bad", text: "Key was refused" };
      if (outcome.tone === "ok") return { tone: "ok", text: a.endpoint?.hasKey ? "Key works" : "Works" };
      return { tone: outcome.tone, text: outcome.text };
    }
    if (a.signedIn === false) return { tone: "bad", text: a.endpoint?.hasKey ? "Key was refused" : "Can't be used" };
    if (catalog?.live === false) return { tone: "bad", text: "Can't reach it" };
    return { tone: "idle", text: "Not tested yet" };
  }
  if (a.signedIn === true) return { tone: "ok", text: ["Signed in", a.plan].filter(Boolean).join(" · ") };
  return a.signedIn === false ? { tone: "warn", text: "Not signed in" } : { tone: "idle", text: "Sign-in not checked yet" };
}

/** Whether an account can have a spending limit: one billed per use (never a plan sign-in, nor a flat monthly fee). */
export function canLimit(a: AgentAccount, spend: AccountSpend | undefined): boolean {
  return a.kind === "apikey" || (a.kind === "endpoint" && !spend?.flat);
}

/** The spending limit button on a row: what it says by how the limit stands. */
export function limitButton(spend: AccountSpend | undefined): string {
  if (!spend?.budget) return "Set a spending limit";
  return spend.budget.state === "stopped" ? "Raise spending limit" : "Change spending limit";
}

/** One agent's line above its accounts: "Claude Code 2.1.330 · installed", with what can be done when something can. */
export interface AgentLine {
  text: string;
  tone: "ok" | "warn" | "idle";
  /** The install it offers: Install when it's missing (or unusable), Update when there's a reason to. */
  action: "Install" | "Update" | null;
  /** Why it can't be used, or what Update does. */
  note: string | null;
}

export function agentLine(provider: Provider, status: ProviderStatus | undefined): AgentLine {
  const name = PROVIDER_INFO[provider].name;
  if (!status || !status.checkedAt) return { text: `${name} · checking…`, tone: "idle", action: null, note: null };
  if (!status.installed) return { text: `${name} · not installed`, tone: "warn", action: "Install", note: provider === "opencode" ? "Install it to run a service with it." : null };
  const version = status.version ? ` ${status.version}` : "";
  if (provider === "opencode") {
    const s = openCodeState(status);
    if (s.action) return { text: `${name}${version} · ${s.word.toLowerCase()}`, tone: "warn", action: s.action, note: s.line };
  }
  return { text: `${name}${version} · installed`, tone: "ok", action: null, note: null };
}
