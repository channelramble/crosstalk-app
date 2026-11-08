// Prompt templates (hub templates.ts): Settings → Templates keeps each machine's, and New chat → From a template starts a chat
// from one. A template's first message can have blanks, "{like this}", that New chat asks for. A blank is a few plain words:
// code (`…` and ``` blocks) is left as it is, and so is anything code-like in braces ({"a": 1}, ${name}). The pure parts are
// here (no store: unit-tested); templateApi.ts talks to the hubs.

import { EFFORT_LABELS, PROVIDER_INFO, type PromptTemplate, type Room, type TemplateInput } from "@crosstalk/shared";
import { folderName } from "./chatList";

/** The longest blank name: longer, it's text in braces, not a blank. */
export const BLANK_MAX = 40;

/** What a blank's name may be made of: words, numbers and a little punctuation (never code's). */
const NAME = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} _.,'’/?!&+-]*$/u;

/** A template's text cut into what stays as it is and its blanks, in order. */
export type Piece = { text: string } | { blank: string; raw: string };

/** Where the code is (fenced blocks to their end or the text's, then `inline` spans): [start, end) each. */
function codeRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(/```[\s\S]*?(?:```|$)/g)) out.push([m.index, m.index + m[0].length]);
  const inFence = (i: number) => out.some(([a, b]) => i >= a && i < b);
  for (const m of text.matchAll(/`[^`\n]*`/g)) if (!inFence(m.index)) out.push([m.index, m.index + m[0].length]);
  return out.sort((a, b) => a[0] - b[0]);
}

/** The blank that opens with `braces` braces at `i`: one line, no braces inside, no code starting in it, a few plain words. */
function blankAt(text: string, i: number, braces: number, code: [number, number][]): { blank: string; raw: string } | null {
  const close = "}".repeat(braces);
  const end = text.indexOf(close, i + braces);
  if (end < 0) return null;
  const inner = text.slice(i + braces, end);
  const name = inner.trim();
  if (inner.length > BLANK_MAX || /[{}\n]/.test(inner) || !NAME.test(name) || code.some(([a]) => a > i && a < end)) return null;
  return { blank: name, raw: text.slice(i, end + braces) };
}

/** The text in pieces: what stays, and each blank (its name trimmed, `raw` as written). */
export function pieces(text: string): Piece[] {
  const code = codeRanges(text);
  const out: Piece[] = [];
  let kept = "";
  let i = 0;
  while (i < text.length) {
    const inCode = code.find(([a, b]) => i >= a && i < b);
    if (inCode) {
      kept += text.slice(i, inCode[1]);
      i = inCode[1];
      continue;
    }
    // "{{name}}" too, as other prompt tools write blanks (the braces go with it); one that isn't a blank is tried as "{…}".
    const blank = text[i] === "{" && !/[$#%]/.test(text[i - 1] ?? "") ? blankAt(text, i, text.startsWith("{{", i) ? 2 : 1, code) ?? blankAt(text, i, 1, code) : null;
    if (blank) {
      if (kept) out.push({ text: kept });
      kept = "";
      out.push(blank);
      i += blank.raw.length;
      continue;
    }
    kept += text[i];
    i++;
  }
  if (kept) out.push({ text: kept });
  return out;
}

/** The blanks a text asks for, each once, in the order they first come. */
export function blanksIn(text: string): string[] {
  return [...new Set(pieces(text).flatMap((p) => ("blank" in p ? [p.blank] : [])))];
}

/** What a blank is filled in with: only what was typed for it ("{constructor}" or "{toString}" isn't the object's own). */
export const blankValue = (values: Record<string, string>, blank: string): string => (Object.hasOwn(values, blank) ? values[blank] : "");

/** The text with each blank filled in (its ends trimmed); a blank left empty stays as written. */
export function fillBlanks(text: string, values: Record<string, string>): string {
  return pieces(text)
    .map((p) => ("blank" in p ? blankValue(values, p.blank).trim() || p.raw : p.text))
    .join("");
}

/** The blanks still empty. */
export function emptyBlanks(text: string, values: Record<string, string>): string[] {
  return blanksIn(text).filter((b) => !blankValue(values, b).trim());
}

/** A blank's field label: its name with a capital, as a label reads ("what goes wrong" → "What goes wrong"). */
export function blankLabel(name: string): string {
  return name.charAt(0).toLocaleUpperCase() + name.slice(1);
}

/** What a template sets, on one line, for its row: "Codex · gpt-5.5 · High · in site", or "Any agent" when it sets nothing else. */
export function templateLine(t: Pick<PromptTemplate, "agent" | "model" | "effort" | "folder">): string {
  return [
    t.agent ? PROVIDER_INFO[t.agent]?.name ?? t.agent : "Any agent",
    t.agent && t.model,
    t.agent && t.effort && (EFFORT_LABELS[t.effort] ?? t.effort),
    t.folder && `in ${folderName(t.folder)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The start of a template's first message, on one line, for its row. */
export function templatePreview(text: string, max = 120): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** A machine's recent chat folders, newest first, without throwaway temp ones: the folders New chat offers. */
export function recentFolders(rooms: Pick<Room, "cwd" | "updatedAt" | "chat">[], max = 8): string[] {
  const chats = rooms.filter((r) => r.chat).sort((a, b) => b.updatedAt - a.updatedAt);
  return [...new Set(chats.map((r) => r.cwd).filter((f) => f && !/^\/(private\/)?tmp\b/.test(f)))].slice(0, max);
}

/** How a chat runs, as New chat holds it (views/AgentOptions.tsx AgentChoice). */
export interface Choice {
  account: string;
  model: string;
  effort: string;
  helperModel?: string;
}

/** Where New chat is, for the template picked in it: on the template's own machine or not, and that machine's sign-ins. */
export interface TemplateHere {
  ownMachine: boolean;
  /** The machine has this account for the template's agent. */
  hasAccount(id: string): boolean;
  /** The agent's main sign-in is signed in there. */
  mainReady: boolean;
}

/**
 * The account a template's model runs on: its own account (on its own machine, while it's still there), else the main
 * sign-in, whose list the model came from, while that's signed in. Null: its model isn't used (another machine's, or one
 * only a signed-out sign-in has); undefined: it gives neither.
 */
function modelAccount(t: Pick<PromptTemplate, "account" | "model">, here: TemplateHere): string | null | undefined {
  if (t.account && here.ownMachine && here.hasAccount(t.account)) return t.account;
  if (!t.model) return undefined;
  return here.ownMachine && here.mainReady ? "default" : null;
}

/**
 * New chat's choice with a template's account, model and effort on it (`base`: what New chat had, from your defaults). A
 * template without an agent sets none of them. A model goes only with an account that can run it (modelAccount): without
 * one, your account and model stay, and its effort goes on them (AgentOptions drops a level the model doesn't have).
 * Another account means the base's model, effort and helper model (for the other account) aren't kept.
 */
export function withTemplate<C extends Choice>(t: Pick<PromptTemplate, "agent" | "account" | "model" | "effort">, base: C, here: TemplateHere): C {
  if (!t.agent) return base;
  const account = modelAccount(t, here);
  if (!account) return { ...base, effort: t.effort ?? base.effort };
  if (account !== base.account) return { ...base, account, model: t.model ?? "", effort: t.effort ?? "", ...(base.helperModel !== undefined ? { helperModel: "" } : {}) };
  return { ...base, model: t.model ?? base.model, effort: t.effort ?? base.effort };
}

/** What New chat says when it doesn't use what a picked template sets (null when it uses it all), `from`: its machine's name. */
export function templateNote(t: Pick<PromptTemplate, "agent" | "account" | "model" | "folder">, here: TemplateHere, from: string): string | null {
  if (!here.ownMachine) {
    const parts = [t.agent && t.model && "model", t.folder && "folder"].filter(Boolean);
    if (!parts.length) return null;
    return parts.length > 1 ? `Its model and folder are for ${from}, so yours are used here.` : `Its ${parts[0]} is for ${from}, so yours is used here.`;
  }
  if (t.agent && t.model && modelAccount(t, here) === null) return `Its model is for ${PROVIDER_INFO[t.agent].name}'s main sign-in, which isn't signed in here, so yours is used.`;
  return null;
}

/** What runs a template's chats: changed together, or not at all. */
const RUNS: readonly string[] = ["agent", "account", "model", "effort"];

/**
 * What an edit changed (`saved`: the template as the editor opened it), the only fields a save sends: what another device
 * changed meanwhile stays. The agent goes with its account, model and effort, so they never land on another agent.
 */
export function changedInput(saved: TemplateInput, now: TemplateInput): TemplateInput {
  const differs = (k: string) => now[k as keyof TemplateInput] !== saved[k as keyof TemplateInput];
  const runs = RUNS.some(differs);
  return Object.fromEntries(Object.entries(now).filter(([k]) => differs(k) || (runs && RUNS.includes(k))));
}

/** Why a change to a machine's templates didn't happen, in words: an older Crosstalk there, out of reach, or the hub's own words. */
export function templateProblem(e: unknown, machine: string): { why: "older" | "down" | "other"; text: string } {
  const status = (e as { status?: unknown } | null)?.status;
  const message = e instanceof Error ? e.message : String(e);
  if (status === 404 && /^not found$/i.test(message)) return { why: "older", text: olderHub(machine) };
  if (status === 0) return { why: "down", text: `Can't reach ${machine}. Try again when it's back.` };
  if (status === 401) return { why: "other", text: `This device was signed out of ${machine}. Add it again in Settings → Machines.` };
  return { why: "other", text: message };
}

/** A machine whose Crosstalk is from before templates. */
export const olderHub = (machine: string) => `Update Crosstalk on ${machine} to keep templates there.`;

/** One machine's templates, as New chat lists them. */
export interface TemplateGroup<M> {
  machine: M;
  templates: PromptTemplate[];
}

/** Every machine's templates for New chat, machines in their order; those without any (or from before templates) are left out. */
export function templateGroups<M extends { key: string; templates: PromptTemplate[] | null }>(machines: M[]): TemplateGroup<M>[] {
  return machines.flatMap((machine) => (machine.templates?.length ? [{ machine, templates: machine.templates }] : []));
}

/** A template's value in New chat's list: its machine and its id (a machine's key is an address: it has no line breaks). */
export const pickValue = (machineKey: string, id: string) => `${machineKey}\n${id}`;

export function parsePick(value: string): { machineKey: string; id: string } | null {
  const at = value.lastIndexOf("\n");
  return at < 0 ? null : { machineKey: value.slice(0, at), id: value.slice(at + 1) };
}
