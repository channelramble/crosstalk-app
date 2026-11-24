// What the New chat menu offers, as plain functions (the screens in views/NewChatMenu.tsx only draw it): the agents,
// then the AI services you've added, then the model servers running on this machine that aren't added yet, so starting
// a chat with a model of your own is one tap, like starting one with Claude Code.

import { CHAT_PROVIDERS, PROVIDER_INFO, SERVICE_AGENTS, isServiceAgent, serviceAgentFor, serviceModelPick, serviceModelsKept, serviceWorks, type AgentAccount, type ChatProvider, type ServiceAgent, type LocalServer, type ModelOption } from "@crosstalk/shared";
import { serviceWhere, serviceWhereWords, type ServiceWhere } from "./chatIdentity";
import type { Choice } from "./templates";

/** What a New chat dialog opens for: an agent, a service of yours, a server to add first, or a group chat. */
export type NewChatTarget =
  | { kind: "agent"; provider: ChatProvider }
  | { kind: "service"; provider: ServiceAgent; account: string; model: string | null; label?: string; noTools?: boolean; machine?: string }
  | { kind: "server"; provider: ServiceAgent; baseUrl: string; label: string; model: string | null; noTools?: boolean; models: LocalServer["models"] }
  | { kind: "group" };

/** One row of the menu. */
export interface StarterRow {
  /** Stable key for the row. */
  id: string;
  target: NewChatTarget;
  /** What the row is called: the agent's name, or the service's. */
  title: string;
  /** The line under it: the model it would run, and where. */
  help: string;
  /** The agent that would drive the chat: a row's own avatar when it isn't a service's (Crosstalk's own agent or OpenCode for some services). */
  provider: ServiceAgent;
  /** Null for an agent (its own avatar); "local" or "web" for a service (its own). */
  where: ServiceWhere | null;
  /** Its model can't run tool calls: the row says so, and the dialog says what that means. */
  noTools: boolean;
}

export interface Starters {
  /** Claude Code and Codex, where they're ready to chat. */
  agents: StarterRow[];
  /** The AI services you've added: the ones on this machine first, then the online ones. */
  services: StarterRow[];
  /** Model servers answering on this machine that no account uses yet: one tap adds and starts. */
  servers: StarterRow[];
  /** The models of your own in the order every screen shows them: your AI services, then the servers to add. */
  yours: StarterRow[];
}

export interface StarterInput {
  /** The agents that can chat (ready on some machine). */
  ready: ChatProvider[];
  /** The open machine's accounts. */
  accounts: AgentAccount[];
  /** Model servers found on this machine (GET /api/local-servers); none until that answers. */
  servers?: LocalServer[];
  /** Which agents are installed here, so a server to be added names the agent that will really run it. */
  installed?: Partial<Record<ServiceAgent, boolean>>;
  /** A service's models as the hub lists them now, for its default and whether that one can run tools. */
  models?: (a: AgentAccount) => ModelOption[] | null;
  /** This machine's name, with more than one linked ("on the Mac mini" rather than "on this machine"). */
  machine?: string | null;
}

const isChatProvider = (p: string): p is ChatProvider => (CHAT_PROVIDERS as readonly string[]).includes(p);

/** A model server's address as one thing to compare: its host and port, when it is the whole address. */
function serverHost(url: string | undefined): string | null {
  try {
    const u = new URL(url ?? "");
    return u.pathname.replace(/\/+$/, "") === "" ? u.host : null;
  } catch {
    return null;
  }
}

/** The line under a service: its model, how many it has, and where it runs — short enough for a phone. */
function serviceHelp(model: string | null, models: number, where: string): string {
  return [model ?? "No model yet", models > 1 ? `${models} models` : "", where].filter(Boolean).join(" · ");
}

/**
 * The menu's rows. A service's model is the first of its own (the default), with the hub's live list preferred so a
 * model dropped at the server shows up; a found server's is the first the hub would save for it, which is the same model
 * Settings → AI services would have picked.
 */
export function chatStarters(input: StarterInput): Starters {
  const agents: StarterRow[] = input.ready.filter(isChatProvider).map((p) => ({
    id: `agent:${p}`,
    target: { kind: "agent", provider: p },
    title: PROVIDER_INFO[p].name,
    help: PROVIDER_INFO[p].vendor,
    provider: p,
    where: null,
    noTools: false,
  }));

  const services = input.accounts
    // A service runs on its agent's program, so one whose agent isn't on this machine isn't offered: the chat would be
    // made and then have nothing to answer with. (Unknown counts as installed: nothing is hidden while the hub is still
    // being asked.) An agent's own sign-in isn't needed — a service is its own.
    // Crosstalk's own agent is built in, so a service it runs is always offered.
    .filter((a) => a.kind === "endpoint" && isServiceAgent(a.provider) && !!a.endpoint && (a.provider === "builtin" || input.installed?.[a.provider] !== false))
    .map((a) => {
      const live = input.models?.(a) ?? null;
      const saved = a.endpoint?.models ?? [];
      // The account's own first model is its default; the live list only says what that model can do.
      const model = saved[0] ?? live?.[0]?.id ?? null;
      const listed = live?.length ? live.length : saved.length;
      const noTools = !!model && !!live?.some((m) => m.id === model && m.noTools);
      return {
        a,
        row: {
          id: `service:${a.provider}:${a.id}`,
          target: { kind: "service" as const, provider: a.provider as ServiceAgent, account: a.id, model, label: a.label, noTools },
          title: a.label,
          help: serviceHelp(model, listed, serviceWhereWords(a, input.machine)),
          provider: a.provider as ServiceAgent,
          where: serviceWhere(a),
          noTools,
        },
      };
    })
    // The ones on this machine first (free, and nothing leaves it), then the online ones, each by name — and two of one
    // name in the agents' own order, so the menu doesn't shuffle them about.
    .sort((x, y) => Number(x.row.where === "web") - Number(y.row.where === "web") || x.a.label.localeCompare(y.a.label) || SERVICE_AGENTS.indexOf(x.row.provider) - SERVICE_AGENTS.indexOf(y.row.provider))
    .map((s) => s.row);
  // The same name under both agents (two services of yours that happen to share one): the agent that drives it goes in
  // the line below, because that is the whole difference between the two rows — the model lock, the helpers and the
  // permissions are that agent's.
  const shared = new Set(services.filter((r, i) => services.some((o, j) => j !== i && o.title === r.title)).map((r) => r.title));
  for (const row of services) if (shared.has(row.title)) row.help = `${row.help} · ${PROVIDER_INFO[row.provider].name}`;

  // A server an account already points at isn't one to add: the scan says so (`accountIds`), and so do the accounts
  // themselves, which arrive the moment one is added — before the next look for servers.
  const taken = new Set(input.accounts.filter((a) => a.kind === "endpoint").map((a) => serverHost(a.endpoint?.baseUrl)).filter(Boolean));
  const servers: StarterRow[] = (input.servers ?? [])
    .filter((s) => !s.accountIds.length && !taken.has(serverHost(s.baseUrl)))
    .flatMap((s) => {
      const provider = serviceAgentFor(serviceWorks(s.protocols), "codex", null, input.installed);
      // The models the hub can save for it, picked the way the hub will pick: a server with none isn't offered, nor one
      // neither agent can use — one tap couldn't start anything with either.
      const kept = serviceModelsKept(s.models);
      if (!provider || !kept.length) return [];
      const picked = serviceModelPick(kept);
      const model = picked[0] ?? kept[0].id;
      const noTools = kept.some((m) => m.id === model && m.tools === false);
      return [{
        id: `server:${s.id}`,
        target: { kind: "server" as const, provider, baseUrl: s.baseUrl, label: s.label, model, noTools, models: s.models },
        title: s.label,
        help: serviceHelp(model, kept.length, "add it and start"),
        provider,
        where: "local" as const,
        noTools,
      }];
    });

  return { agents, services, servers, yours: [...services, ...servers] };
}

/** The rows for one agent's own screen ("Models on Codex"): its services, and the servers it would be the one to run. */
export function agentStarters(rows: StarterRow[], provider: ChatProvider): StarterRow[] {
  return rows.filter((row) => row.target.kind !== "group" && row.target.kind !== "agent" && row.target.provider === provider);
}

/**
 * What the menu's tap fixes in New chat, whatever your saved defaults for that agent say: the account (the service
 * itself, or the one the hub is about to make for a server) and the model
 * the row offered. The effort and the helper model go with them, exactly as switching the account by hand drops them:
 * they were chosen for another account's models, and naming one this service doesn't serve would lock every helper in
 * the chat to a model that isn't there (a service's models have their own effort levels, or none). Your permissions
 * still come from the defaults.
 */
export function targetChoice<C extends Choice>(base: C, target: NewChatTarget): C {
  const fixed =
    target.kind === "service"
      ? { account: target.account, model: target.model ?? "" }
      : target.kind === "server"
        ? { account: "default", model: target.model ?? "" }
        : null;
  if (!fixed) return base;
  return { ...base, ...fixed, effort: "", ...(base.helperModel !== undefined ? { helperModel: "" } : {}) };
}

/**
 * Whether an account of an agent's can answer: its sign-in is in, its API key works, or it's a service of yours. Null
 * when that isn't known (not checked yet, or not an account the hub lists). `main`: the agent's own sign-in as the
 * agent's status has it, for when the hub doesn't list it among the accounts.
 */
export function accountAnswers(accounts: AgentAccount[], provider: ServiceAgent, id: string, main?: boolean | null): boolean | null {
  const a = accounts.find((x) => x.provider === provider && x.id === id);
  return a ? a.signedIn : id === "default" ? main ?? null : null;
}

/**
 * The choice New chat opens with for an agent: yours (`base`, from your saved defaults), unless its account is signed
 * out and another of the agent's accounts can answer — a second sign-in, an API key, a service of yours. Then the first
 * of those, so someone who has only added an AI service never starts on "Main · not signed in" and gets an error for a
 * first reply. The model, effort and helper model go, as they do when the account is switched by hand: they were
 * picked for the other account's models. With no account that can answer, yours stays and New chat offers the sign-in.
 */
export function answeringChoice<C extends Choice>(base: C, provider: ServiceAgent, accounts: AgentAccount[], main?: boolean | null): C {
  if (accountAnswers(accounts, provider, base.account, main) !== false) return base;
  const other = accounts.find((a) => a.provider === provider && a.signedIn === true);
  if (!other) return base;
  return { ...base, account: other.id, model: "", effort: "", ...(base.helperModel !== undefined ? { helperModel: "" } : {}) };
}

/**
 * What a first chat starts with (the welcome card's "Start a chat"): the first agent whose own sign-in can answer
 * (`own`); with none, the first AI service you've added, as a tap on it in the New chat menu would (the chat is that
 * service's, on the agent that drives it); else an agent that's ready some other way. Null: nothing can chat yet.
 */
export function firstChatTarget(input: { own: ChatProvider[]; services: StarterRow[]; ready: ChatProvider[] }): NewChatTarget | null {
  if (input.own.length) return { kind: "agent", provider: input.own[0] };
  if (input.services.length) return input.services[0].target;
  return input.ready.length ? { kind: "agent", provider: input.ready[0] } : null;
}

/** How many service rows the menu shows before the rest fold away: about what a phone screen holds under the agents. */
export const STARTERS_SHOWN = 4;

/**
 * The rows the menu shows at once, and the ones behind "All your models". Everything shows while it fits; past that,
 * one row makes way for the button, so folding never hides just one.
 */
export function foldStarters(rows: StarterRow[], shown = STARTERS_SHOWN): { first: StarterRow[]; folded: StarterRow[] } {
  if (rows.length <= shown) return { first: rows, folded: [] };
  return { first: rows.slice(0, shown - 1), folded: rows.slice(shown - 1) };
}

/**
 * A server's models as a model picker's, for a server that isn't added yet: there's no account for the hub to list, so
 * the New chat dialog offers what the scan found. The default is the one the hub will save first.
 */
export function serverModelOptions(models: LocalServer["models"]): ModelOption[] {
  // Only the ones an account can keep, so the dialog never offers a model the hub would drop on the way in.
  const kept = serviceModelsKept(models);
  const first = serviceModelPick(kept)[0] ?? kept[0]?.id;
  return kept.map((m) => ({
    id: m.id,
    label: m.id,
    description: null,
    efforts: [],
    defaultEffort: null,
    isDefault: m.id === first,
    contextWindow: m.contextWindow,
    ...(m.tools === false ? { noTools: true } : {}),
  }));
}

/** What a model that can't run tool calls means, in plain words. */
export const noToolsWords = (model: string) => `${model} can talk, but it can't read files or run commands.`;
/** Said as well where a chat is about to start on one: it still can, if talking is all that's wanted. */
export const NO_TOOLS_START = "You can still start the chat and ask it things.";
