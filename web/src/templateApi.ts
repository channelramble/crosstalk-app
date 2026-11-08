// Prompt templates: the requests Settings → Templates and New chat make to a machine's hub (hub templates.ts), and how their
// answers reach the app's state. Each machine keeps its own; every device hears a change from its hub as a `templates` event.

import type { AskChoice, PromptTemplate, TemplateInput } from "@crosstalk/shared";
import { ApiError, api, type Connection } from "./api";
import { askNames, hasMention, mentionedChoices, readTargets } from "./asks";
import { hubStore, useStore } from "./store";
import { templateProblem } from "./templates";

/** A machine, as far as its templates go. */
export interface TemplateMachine {
  key: string;
  name: string;
  conn: Connection;
}

/** A change that didn't happen, in words (templateProblem), with its machine and the hub's reason ("no_template": it's gone). */
export class TemplateError extends Error {
  constructor(
    message: string,
    public machineKey: string,
    public why: "older" | "down" | "other",
    public code?: string,
  ) {
    super(message);
  }
}

/**
 * A change to a machine's templates: shown there at once from its answer (the whole list), unless the list changed meanwhile.
 * The hub sends a `templates` event for every change, this one's too, so word that came first is as new or newer. Throws a
 * TemplateError.
 */
async function change(machine: TemplateMachine, method: string, path: string, body?: unknown): Promise<PromptTemplate[]> {
  const store = hubStore(machine.key);
  const before = store?.getState().templates;
  let list: PromptTemplate[];
  try {
    list = await api<PromptTemplate[]>(method, path, body, machine.conn);
  } catch (e) {
    const p = templateProblem(e, machine.name);
    throw new TemplateError(p.text, machine.key, p.why, e instanceof ApiError ? e.code : undefined);
  }
  if (Array.isArray(list)) store?.setState((s) => (s.templates === before ? { templates: list } : s));
  return list;
}

const at = (id: string) => `/api/templates/${encodeURIComponent(id)}`;

/** A new template, first in the list. */
export const addTemplate = (m: TemplateMachine, input: TemplateInput) => change(m, "POST", "/api/templates", input);
/** Changes what `input` gives (a rename gives only the name). */
export const saveTemplate = (m: TemplateMachine, id: string, input: TemplateInput) => change(m, "PATCH", at(id), input);
/** Deleted: one already gone (deleted on another device) counts as deleted. */
export async function deleteTemplate(m: TemplateMachine, id: string): Promise<void> {
  try {
    await change(m, "DELETE", at(id));
  } catch (e) {
    if (!(e instanceof TemplateError && e.code === "no_template")) throw e;
  }
}
/** To place `to` (0 is the top). */
export const moveTemplate = (m: TemplateMachine, id: string, to: number) => change(m, "POST", `${at(id)}/move`, { to });
/** The starters that were deleted, back at the end. */
export const restoreStarters = (m: TemplateMachine) => change(m, "POST", "/api/templates/starters");

/** Says why a change didn't happen: a machine that can't be reached gets Try now. */
export function templateFailed(e: unknown) {
  const app = useStore.getState();
  if (e instanceof TemplateError && e.why === "down") app.toast("error", e.message, { action: { label: "Try now", run: () => useStore.getState().reconnectNow(e.machineKey) } });
  else if (e instanceof TemplateError && e.why === "older") app.toast("warn", e.message);
  else app.toast("error", e instanceof Error ? e.message : String(e));
}

/** The chat's message box keeps this until it's sent (views/Composer.tsx keeps its drafts under the same key). */
function keepDraft(roomId: string, text: string) {
  try {
    localStorage.setItem(`crosstalk.draft.${roomId}`, text);
  } catch {
    // storage unavailable (private mode): the message box starts empty
  }
}

const listed = (names: readonly string[]) => (names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/**
 * A chat's first message from a template, sent once the chat is made. One that names another agent (by the chat's list of who
 * can be asked, as the message box tells them: "@types/react" names nobody) isn't sent: others are asked about a message in the
 * chat (asks.ts sendPlan), and a new one has none, so it waits in the message box, whose Send offers to take the @names off or
 * send it as it is. So does one whose @names couldn't be checked, and one that can't be sent. Answers what to tell the person
 * when it wasn't sent (null when it was). `agent`: the chat's agent's name.
 */
export async function sendFirstMessage(conn: Connection, roomId: string, text: string, agent: string): Promise<string | null> {
  if (hasMention(text)) {
    let named: AskChoice[];
    try {
      // The hub leaves the chat's own agent out of the list (its name in the message is just text).
      named = mentionedChoices(text, readTargets(await api<unknown>("GET", `/api/asks/targets?room=${encodeURIComponent(roomId)}&machines=1`, undefined, conn)).choices);
    } catch {
      keepDraft(roomId, text);
      return "Couldn't check who the @name in your first message is, so it's waiting in the message box. Send it from there.";
    }
    if (named.length) {
      keepDraft(roomId, text);
      return `Your first message names ${listed(askNames(named, agent))}, who can only be asked about a message in the chat. It's in the message box: take off ${listed(named.map((c) => `@${c.handle}`))} to send it to ${agent}.`;
    }
  }
  try {
    await api("POST", `/api/rooms/${encodeURIComponent(roomId)}/messages`, { text }, conn);
    return null;
  } catch (e) {
    keepDraft(roomId, text);
    const why = (e instanceof Error ? e.message : String(e)).replace(/[.\s]+$/, "");
    return `The chat started, but its first message didn't go: ${why}. It's waiting in the message box. Send it from there.`;
  }
}
