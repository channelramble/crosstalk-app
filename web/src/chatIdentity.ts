// What a chat is, in its own words. A chat whose account is an AI service of yours (a model on this machine or an online
// one) says that service and its model everywhere it names itself: the header, the avatar, the chat list. Which agent drives it (Claude Code or Codex) stays in the chat's settings and the model menu, because that's
// what the model lock, the helper agents and the permissions follow.

import { CHAT_PROVIDERS, PROVIDER_INFO, isLocalAddress, type AgentAccount, type ChatProvider, type Member, type Room } from "@crosstalk/shared";
import { accountKey, memberAccount } from "./accounts";

/** Where a service runs: on the hub's own machine (free, nothing leaves it), or on the web. */
export type ServiceWhere = "local" | "web";

/** Service avatars get their own colours, so a chat on one is never read as Claude Code's or Codex's. */
export const SERVICE_COLOR: Record<ServiceWhere, string> = { local: "#7c5cff", web: "#00a0b8" };

export interface ChatIdentity {
  /** The agent that drives the chat: the model lock, the helpers and the permissions are its. */
  provider: ChatProvider;
  /** The service the chat runs on, when its account is one of yours. */
  service: AgentAccount | null;
  /** Where that service is; null when the chat runs on the agent's own sign-in. */
  where: ServiceWhere | null;
  /** What the chat calls itself: the service's name, else the agent's. */
  name: string;
  /** The model it runs, when it has one. */
  model: string | null;
  /** Its avatar's colour, and the tint of its header. */
  color: string;
  /** The chat list's group for it: one per service, beside the agents' own. */
  groupKey: string;
}

/** The chat list's group for a service's chats. Its id is this hub's own, so two machines' services never share one. */
export const serviceGroup = (provider: ChatProvider, accountId: string): string => `svc:${provider}:${accountId}`;

/** The service a member runs on: its account, when that account is a service of yours rather than a sign-in or an API key. */
export function chatService(member: Pick<Member, "provider" | "config"> | undefined, accounts: Record<string, AgentAccount>): AgentAccount | null {
  if (!member) return null;
  const account = accounts[accountKey(member.provider, memberAccount(member))];
  return account?.kind === "endpoint" ? account : null;
}

export const serviceWhere = (a: AgentAccount): ServiceWhere => (isLocalAddress(a.endpoint?.baseUrl) ? "local" : "web");

/** Under a service's name: where it runs ("on this machine", or the host it answers at). */
export function serviceWhereWords(a: AgentAccount, machine?: string | null): string {
  if (serviceWhere(a) === "local") return machine ? `on ${machine}` : "on this machine";
  try {
    return new URL(a.endpoint?.baseUrl ?? "").host;
  } catch {
    return "on the web";
  }
}

/**
 * What a one-agent chat is: its service and model, or its agent. A group chat keeps its own identity (its agents are
 * listed instead), so this is only asked of chats with one agent.
 */
export function chatIdentity(room: Pick<Room, "chat"> | null, member: Member | undefined, accounts: Record<string, AgentAccount>): ChatIdentity {
  const provider = ((room?.chat?.provider ?? member?.provider ?? "claude") as ChatProvider);
  const service = chatService(member, accounts);
  const model = member?.resolvedModel ?? member?.model ?? service?.endpoint?.models[0] ?? null;
  if (!service) return { provider, service: null, where: null, name: PROVIDER_INFO[provider].name, model, color: PROVIDER_INFO[provider].color, groupKey: provider };
  const where = serviceWhere(service);
  return { provider, service, where, name: service.label, model, color: SERVICE_COLOR[where], groupKey: serviceGroup(provider, service.id) };
}

/** Where a chat's model runs, in plain words, for the chat's own screens: the machine it's on, or the host it answers at. */
export function identityWhere(identity: ChatIdentity, machine?: string | null): string {
  return identity.service ? serviceWhereWords(identity.service, machine) : "";
}

/** One group of the chat list. */
export interface ChatGroup {
  key: string;
  title: string;
  /** The agent that drives it: its own, for an agent's group; the one behind the service, for a service's. */
  agent: ChatProvider;
  /** Set for an agent's own group: its header shows its plan limit and opens its page. */
  provider: ChatProvider | null;
  /** Set for a service's group. */
  service: AgentAccount | null;
  where: ServiceWhere | null;
  /** Which machine the service lives on, so New chat from its heading starts there. "" for the hub this app opened from. */
  machine: string;
}

/**
 * The chat list's groups, in order: Claude Code, Codex (always, even with no chats yet), then one for every AI service
 * that has chats — the ones on this machine first, then the online ones, each by name. So a chat on a model of yours is
 * listed under that model instead of being mixed in with Codex's.
 */
export function chatGroups(rows: { identity: ChatIdentity; machine: string; machineName?: string | null }[]): ChatGroup[] {
  const agents: ChatGroup[] = CHAT_PROVIDERS.map((p) => ({ key: p, title: PROVIDER_INFO[p].name, agent: p, provider: p, service: null, where: null, machine: "" }));
  const services = new Map<string, ChatGroup>();
  /** Which machine each service's group was found on, in words, for a name that two machines both use. */
  const where = new Map<string, string | null>();
  for (const { identity, machine, machineName } of rows) {
    if (!identity.service || services.has(identity.groupKey)) continue;
    services.set(identity.groupKey, { key: identity.groupKey, title: identity.name, agent: identity.provider, provider: null, service: identity.service, where: identity.where, machine });
    where.set(identity.groupKey, machineName ?? null);
  }
  // Every heading says something of its own: two rows of the same words are two groups a person can't tell apart. A
  // service named like another one says which agent drives it, since that's the whole difference between their chats;
  // one named after an agent (nothing stops a model of yours being called "Codex"), or like another service of the
  // same agent, says where it runs instead — the agent wouldn't tell those apart.
  const given = new Map<ChatGroup, string>([...services.values()].map((g) => [g, g.title]));
  const names = new Map<string, number>();
  for (const title of [...agents.map((g) => g.title), ...given.values()]) names.set(title, (names.get(title) ?? 0) + 1);
  for (const [g, title] of given) {
    if ((names.get(title) ?? 0) < 2) continue;
    const agentName = PROVIDER_INFO[g.agent].name;
    const twin = [...given].some(([x, t]) => x !== g && t === title && x.agent === g.agent);
    const runsAt = g.service ? serviceWhereWords(g.service, where.get(g.key)) : "";
    g.title = `${title} · ${(title === agentName || twin) && runsAt ? runsAt : agentName}`;
  }
  // This machine's services, then the online ones.
  const sorted = [...services.values()].sort((a, b) => Number(a.where === "web") - Number(b.where === "web") || a.title.localeCompare(b.title));
  return [...agents, ...sorted];
}
