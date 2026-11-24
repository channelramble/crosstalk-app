import { CHAT_PROVIDERS, EFFORT_LABELS, PROVIDER_INFO, heldWords, permissionInfo, type AgentDefaults, type Member, type ModelOption, type PermissionMode, type Provider } from "@crosstalk/shared";
import { sameModelId } from "./models";

// A chat's settings sheet (views/ChatSettingsSheet.tsx) and the summary row under the message box (views/ChatControls.tsx):
// the words they say and which sections a chat has, kept here so they can be tested without a screen.

/** A section of the sheet. The first four are an agent's own; "agent" is a group chat agent's name and role. */
export type SectionId = "answers" | "may" | "helpers" | "memory" | "agent" | "group" | "chat";

export const SECTION_TITLES: Record<SectionId, string> = {
  answers: "Answers with",
  may: "May do",
  helpers: "Helpers",
  memory: "Memory",
  agent: "Name and role",
  group: "Working together",
  chat: "This chat",
};

/** Where the sheet opens: a section, and in a group chat whose. Nothing: the overview, every section closed. */
export interface SheetAt {
  section?: SectionId;
  memberId?: string;
}

/** Agents whose helpers Crosstalk can hold to a model (Claude Code's subagents and workflows, Codex's spawned agents). */
const WITH_HELPERS: Provider[] = ["claude", "codex"];

/** An agent's own sections, in order. Helpers only where the agent has any; name and role only in a group chat. */
export function agentSections(provider: Provider, group: boolean): SectionId[] {
  return ["answers", "may", ...(WITH_HELPERS.includes(provider) ? (["helpers"] as const) : []), "memory", ...(group ? (["agent"] as const) : [])];
}

/** The sheet's top-level sections: a group chat's own comes first, "This chat" is always last. */
export function sheetSections(group: boolean, provider: Provider | null): SectionId[] {
  return group ? ["group", "chat"] : [...(provider ? agentSections(provider, false) : []), "chat"];
}

/** The key one section's open state is kept under (an agent's sections are its own). */
export const foldKey = (section: SectionId, memberId?: string | null) => (memberId && section !== "group" && section !== "chat" ? `${memberId}:${section}` : section);

/** What's open when the sheet opens at `at`: that section and, in a group chat, the agent's block around it. */
export function openAt(at: SheetAt | null | undefined, group: boolean): string[] {
  if (!at?.section) return at?.memberId && group ? [`agent:${at.memberId}`] : [];
  const key = foldKey(at.section, at.memberId);
  return group && at.memberId && key !== at.section ? [`agent:${at.memberId}`, key] : [key];
}

/** Effort as a step or a chip says it: one short word, in the agent's own names. */
const EFFORT_SHORT: Record<string, string> = { ...EFFORT_LABELS, xhigh: "Extra" };
export const effortWord = (e: string) => EFFORT_SHORT[e] ?? e;
export const effortName = (e: string) => EFFORT_LABELS[e] ?? e;

/** What a level costs, under the steps. `level` "" is the agent's own pick. */
export function effortHint(levels: readonly string[], level: string, agentName: string): string {
  if (!level) return `${agentName} picks how hard to think for each reply.`;
  const i = levels.indexOf(level);
  if (levels.length > 1 && i === 0) return "The quickest replies. Uses the least of your plan.";
  if (levels.length > 1 && i === levels.length - 1) return "Thinks the longest. Uses the most of your plan.";
  return "Higher thinks longer and uses more of your plan.";
}

/** The model as the chat's list names it; a model the list doesn't have by the name it was saved under. */
export function modelWord(member: Pick<Member, "model" | "resolvedModel">, models: readonly ModelOption[]): string {
  const actual = member.resolvedModel ?? member.model;
  if (!actual) return models.find((m) => m.isDefault)?.label ?? "Default model";
  const listed = models.find((m) => m.id === actual || m.resolvedModel === actual) ?? models.find((m) => sameModelId(m.resolvedModel ?? m.id, actual) || sameModelId(m.id, actual));
  return listed?.label ?? actual;
}

/** The effort in force: what was picked if the model takes it, else the model's own default ("" when it says none). */
export function effortInForce(member: Pick<Member, "config">, model: Pick<ModelOption, "efforts" | "defaultEffort"> | undefined): string {
  const picked = typeof member.config?.effort === "string" ? member.config.effort : "";
  const levels = model?.efforts ?? [];
  return picked && levels.includes(picked) ? picked : model?.defaultEffort ?? "";
}

/** What the two chips under the message box say: "Opus 5.5 · High" and "Asks first". */
export function chipWords(member: Pick<Member, "provider" | "model" | "resolvedModel" | "config" | "permissionMode">, models: readonly ModelOption[], model?: Pick<ModelOption, "efforts" | "defaultEffort">): { answers: string; may: string; danger: boolean } {
  const effort = effortInForce(member, model);
  const perm = permissionInfo(member.provider, member.permissionMode);
  return { answers: [modelWord(member, models), effort ? effortWord(effort) : null].filter(Boolean).join(" · "), may: perm.short, danger: perm.tone === "red" };
}

const BUSY = ["thinking", "working", "approval", "queued"];
export const isBusy = (m: Pick<Member, "status">) => BUSY.includes(m.status);

/**
 * What happens when a choice is made, said next to it before it's made. "settings": the model, effort and its extras;
 * "permissions"; "account": a switch starts the agent fresh.
 */
export function whenWords(what: "settings" | "permissions" | "account", member: Pick<Member, "status">, agentName: string): string {
  const busy = isBusy(member);
  if (what === "account") return `Switching accounts starts ${agentName} fresh: it forgets what was said so far. The messages stay.${busy ? ` It happens once ${agentName} finishes this reply.` : ""}`;
  if (busy) return `${agentName} is replying now. A change here applies once this reply ends.`;
  return what === "permissions" ? `A change applies from ${agentName}'s next reply.` : `A change applies from ${agentName}'s next reply. The chat carries on as it is.`;
}

/** A change that's still waiting to apply (Member.held), as the sheet says it; null when nothing waits. */
export function heldLine(member: Pick<Member, "held">, agentName: string): string | null {
  const held = member.held;
  if (!held) return null;
  const what = heldWords(held.change);
  return `${what.charAt(0).toUpperCase()}${what.slice(1)} once ${agentName} finishes ${held.helpers ? "its helpers" : "this reply"}.`;
}

/** What "Use these for new chats too" saves: the chat's own choices, as Settings → New chats keeps them. */
export function asDefaults(member: Pick<Member, "model" | "config" | "permissionMode">): AgentDefaults {
  const text = (v: unknown) => (typeof v === "string" && v ? v : null);
  const account = text(member.config?.account);
  return { permissionMode: member.permissionMode, model: member.model || null, effort: text(member.config?.effort), helperModel: text(member.config?.helperModel), ...(account && account !== "default" ? { account } : {}) };
}

/** Whether new chats with this agent already start the way this chat runs (so there's nothing to offer). */
export function startsLikeThis(member: Pick<Member, "model" | "config" | "permissionMode">, defaults: AgentDefaults | undefined): boolean {
  const mine = asDefaults(member);
  const theirs = defaults ?? { permissionMode: "ask" as PermissionMode, model: null, effort: null };
  return mine.permissionMode === theirs.permissionMode && (mine.model ?? null) === (theirs.model ?? null) && (mine.effort ?? null) === (theirs.effort ?? null) && (mine.helperModel ?? null) === (theirs.helperModel ?? null) && (mine.account ?? "default") === (theirs.account ?? "default");
}

/** New chats' defaults are kept per agent a chat can start with on its own; a service's chat keeps its own. */
export const hasDefaults = (provider: Provider, service: boolean) => !service && (CHAT_PROVIDERS as readonly Provider[]).includes(provider);

/** How full the model's memory of the chat is, in a section's closed row and the ring's name. */
export function memoryWords(tokens: number | null, window: number | null): { pct: number | null; words: string } {
  if (!tokens || !window) return { pct: null, words: "Shown after the next reply" };
  const pct = Math.min(100, Math.round((tokens / window) * 100));
  return { pct, words: `${pct}% full` };
}

/** One agent of a group chat in a line: "Claude Code · Opus 5.5 · High · Asks first". */
export function agentLine(member: Member, models: readonly ModelOption[], accountLabel?: string | null): string {
  const picked = typeof member.config?.effort === "string" && member.config.effort ? effortWord(member.config.effort) : null;
  return [PROVIDER_INFO[member.provider]?.name ?? member.provider, accountLabel, modelWord(member, models), picked, permissionInfo(member.provider, member.permissionMode).short].filter(Boolean).join(" · ");
}
