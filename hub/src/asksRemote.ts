// Ask others on the person's other linked machines (docs/SPEC-0.5.md, track T11): what isn't the Asks class's own.
// Asking side: the rows each linked hub says it can run (`PeerLists`: kept 30 seconds, 3 seconds to answer, and a machine that
// didn't answer isn't waited for again, so it never slows the sheet), and what a failed call says in plain words. Answering
// side (the route is in asks.ts): the checks a stranger's request to run a model on this hub must pass: its size is counted as
// it arrives (`readCapped`), it runs in a fresh empty folder (`scratchFolder`) and what comes back is cut. Everything another
// hub says is checked here, never trusted.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_PROVIDERS, type AskChoice, type AskModel, type AskTarget, type ChatProvider, type CostBasis } from "@crosstalk/shared";
import type { App } from "./app";
import { HttpError } from "./engine/engine";
import { hubCall } from "./machines";

export const MODEL = /^\w[\w.:@/[\]-]{0,99}$/;
export const EFFORT = /^[a-z]{2,12}$/;
export const ACCOUNT = /^[\w.:@-]{1,64}$/;

/**
 * Why a question from another machine can't run Codex here. Codex's read-only sandbox keeps writes out, but lets it read any
 * file on this machine, so a fresh empty folder as its working folder wouldn't keep a stranger's question away from them (Claude
 * Code asks before reading outside its folder, and every approval is refused). Until Codex's read scope can be limited to that
 * folder (that needs a check with the real Codex), its rows are listed greyed with this, and a question for one is refused.
 */
export const CODEX_ELSEWHERE = "Codex can't be asked from another machine yet";

/** What a question from another machine may hold (its note and its question together), what's kept of an answer, and the most a request weighs (bytes). */
export const PEER_CHARS = 60_000;
export const PEER_ANSWER = 8_000;
export const PEER_BODY = 400_000;
/** How many questions one linked machine may send here in a window. */
export const PEER_RATE = { n: 20, ms: 10 * 60_000 };

// ------------------------------------------------------------------------------------------------ words

export const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What another hub sends as text (a name, a reason): one short line without control characters. */
const line = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

/**
 * A row's name with another of its models: "Claude Code · Sonnet 4.6" from "Claude Code · Opus 5.5" (the account as its machine
 * names it, then the model's own name). A name with no model in it gets the model after it.
 */
export function withModel(label: string, model: string): string {
  const at = label.indexOf(" · ");
  return `${at < 0 ? label : label.slice(0, at)} · ${model}`;
}

/** A machine's name inside a sentence: "the PC", "the Mac mini", but "Anna's laptop" as it is. */
export const theMachine = (name: string) => (/^the\s/i.test(name) || /['’]s\b/.test(name) ? name : `the ${name}`);

/** "The PC didn't answer." (the sheet's muted line; a card adds what to do). */
export const noAnswer = (name: string) => `${capital(theMachine(name))} didn't answer.`;
export const turnedOff = (name: string) => `Agents across chats is off on ${theMachine(name)}: turn it on in its Settings.`;

/** What to type after @ for another machine's agent: its own handle and the machine, never one already taken ("qwen-on-pc"). */
export function remoteHandle(handle: string, machine: string, taken: ReadonlySet<string>): string {
  const slug =
    machine
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .slice(0, 16)
      .replace(/-+$/, "") || "other";
  const base = `${handle.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "agent"}-on-${slug}`;
  let out = base;
  for (let n = 2; taken.has(out); n++) out = `${base}-${n}`;
  return out;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const down = (e: Partial<HttpError>) => e.code === "unreachable" || e.status === 502 || e.status === 504;

/** Why a linked machine's call failed, as a card's error says it: what happened and what to do (always with Try again). */
export function peerProblem(e: unknown, name: string, url: string): string {
  const err = (e ?? {}) as Partial<HttpError>;
  const there = capital(theMachine(name));
  if (err.code === "off") return turnedOff(name);
  if (down(err)) return `${noAnswer(name)} Check it's on, then Try again.`;
  if (err.status === 401) return `${there} no longer accepts this machine's sign-in. Link it again under Settings → Machines, then Try again.`;
  if (err.code === "not_linked" || err.code === "peer_scope") return `${there} doesn't have this machine linked for this yet. Check Settings → Machines, then Try again.`;
  // The other hub's own sentence, without its address in front.
  const said = line(String(err.message ?? "").replace(`${hostOf(url)}: `, ""), 300);
  if (err.status === 404 && (!said || /^not found\.?$/i.test(said))) return `${there} needs a Crosstalk update before it can answer. Update it, then Try again.`;
  // Its stop for too many questions from this machine lasts minutes: said as that, not as a moment's busyness.
  if (err.code === "rate") return `${there} is taking no more questions from this machine for a few minutes. Try again later, or pick someone on this machine.`;
  if (err.status === 429) return `${there} is busy with other questions. Try again in a moment.`;
  if (err.status === 413) return `${said || "That chat is too long to send."} Ask about a later message, or pick someone on this machine.`;
  // A money limit gets the way out; a plan window's sentence (also "budget") has its own, and there is nothing to raise.
  if (said) return `On ${theMachine(name)}: ${said}${err.code === "budget" && !/\b(ask again|pick another)\b/i.test(said) ? " Raise its limit in Settings there, or pick another." : ""}`;
  return `${there} couldn't answer. Try again.`;
}

// ------------------------------------------------------------------------------------------------ what another hub says

/** The most models one row from another hub may offer (a model server's own list is cut at 100 too), and all its rows together. */
export const PEER_MODELS = { row: 100, all: 1_000 };

/** A context size (tokens) or a time (ms) another hub sent: a positive whole number of a sensible size, else nothing. */
const size = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1e9 ? Math.round(v) : null);
const time = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1e14 ? Math.round(v) : null);

/**
 * The models another hub says a row can be asked on (asked with ?models=1), kept only when well formed: a known name, short
 * lines, effort levels it names, sizes that are sizes, and what an ask on each costs. Undefined when it sent no list at all
 * (a hub of 0.6.1 or older: its model can't be picked from here). What only matters to its own Codex (the tools' cost) isn't
 * taken: Codex isn't asked from another machine. `budget`: how many more the rows read so far leave room for.
 */
export function readPeerModels(data: unknown, budget: number = PEER_MODELS.row): AskModel[] | undefined {
  if (!Array.isArray(data)) return undefined;
  const out: AskModel[] = [];
  for (const raw of data.slice(0, Math.max(0, Math.min(budget, PEER_MODELS.row)))) {
    const m = (raw ?? {}) as Record<string, unknown>;
    if (typeof m.id !== "string" || !MODEL.test(m.id) || out.some((x) => x.id === m.id)) continue;
    const efforts = Array.isArray(m.efforts) ? [...new Set(m.efforts.filter((e): e is string => typeof e === "string" && EFFORT.test(e)))].slice(0, 10) : [];
    const typical = m.typicalCostUsd;
    out.push({
      id: m.id,
      label: line(m.label, 80) || m.id,
      description: line(m.description, 200) || null,
      efforts,
      defaultEffort: typeof m.defaultEffort === "string" && efforts.includes(m.defaultEffort) ? m.defaultEffort : null,
      isDefault: m.isDefault === true,
      ...(typeof m.resolvedModel === "string" && MODEL.test(m.resolvedModel) ? { resolvedModel: m.resolvedModel } : {}),
      contextWindow: size(m.contextWindow),
      ...(size(m.maxContextWindow) ? { maxContextWindow: size(m.maxContextWindow) } : {}),
      ...(time(m.firstSeen) ? { firstSeen: time(m.firstSeen)! } : {}),
      ...(m.more === true ? { more: true } : {}),
      ...(m.noTools === true ? { noTools: true } : {}),
      paid: m.paid === "yes" || m.paid === "no" ? m.paid : "unknown",
      typicalCostUsd: typeof typical === "number" && Number.isFinite(typical) && typical >= 0 ? typical : null,
    });
  }
  return out;
}

/** The rows another hub says it can run, kept only when well formed: at most 60, short lines, known kinds. */
export function readPeerRows(data: unknown): AskChoice[] {
  const rows: AskChoice[] = [];
  let models = PEER_MODELS.all;
  for (const raw of Array.isArray(data) ? data.slice(0, 60) : []) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const t = (r.target ?? {}) as Record<string, unknown>;
    const provider = (CHAT_PROVIDERS as readonly string[]).includes(t.provider as string) ? (t.provider as ChatProvider) : null;
    // undefined: not a usable name.
    const model = t.model == null ? null : typeof t.model === "string" && MODEL.test(t.model) ? t.model : undefined;
    const effort = t.effort == null ? null : typeof t.effort === "string" && EFFORT.test(t.effort) ? t.effort : undefined;
    const label = line(r.label, 80);
    if (!provider || typeof t.account !== "string" || !ACCOUNT.test(t.account) || model === undefined || effort === undefined || !label) continue;
    const available = r.available === true;
    const typical = typeof r.typicalCostUsd === "number" && Number.isFinite(r.typicalCostUsd) && r.typicalCostUsd >= 0 ? r.typicalCostUsd : null;
    // Newer than 0.6.1: the models it can be asked on (only a row that can be asked has them), or why its model can't be picked.
    const list = available ? readPeerModels(r.models, models) : undefined;
    if (list) models -= list.length;
    rows.push({
      target: { provider, account: t.account, model, effort },
      label,
      sub: line(r.sub, 40),
      handle: line(r.handle, 40),
      paid: r.paid === "yes" || r.paid === "no" ? r.paid : "unknown",
      local: r.local === true,
      available,
      why: available ? null : line(r.why, 120) || "Not available right now",
      typicalCostUsd: typical,
      ...(list ? { models: list } : {}),
      ...(available && r.fixedModel === "pool" ? { fixedModel: "pool" as const } : {}),
    });
  }
  return rows;
}

/** What a question run on another machine came to: the same facts as a one-shot's result, and the cost as that machine worked it out. */
export interface PeerAnswer {
  ok: boolean;
  text: string;
  error: string | null;
  stopped: boolean;
  timedOut: boolean;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; costUsd: number | null; basis: CostBasis };
}

const BASES: readonly string[] = ["exact", "estimated", "unknown", "plan", "free"];

/** The answer to POST /api/asks/peer as this hub trusts it (null: not an answer at all). */
export function readPeerAnswer(data: unknown): PeerAnswer | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const u = (d.usage && typeof d.usage === "object" ? d.usage : {}) as Record<string, unknown>;
  const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
  return {
    ok: d.ok === true,
    text: typeof d.text === "string" ? d.text.slice(0, PEER_ANSWER + 100) : "",
    error: line(d.error, 300) || null,
    stopped: d.stopped === true,
    timedOut: d.timedOut === true,
    usage: {
      inputTokens: count(u.inputTokens),
      outputTokens: count(u.outputTokens),
      cachedInputTokens: count(u.cachedInputTokens),
      costUsd: typeof u.costUsd === "number" && Number.isFinite(u.costUsd) && u.costUsd >= 0 ? u.costUsd : null,
      basis: BASES.includes(u.basis as string) ? (u.basis as CostBasis) : "unknown",
    },
  };
}

// ------------------------------------------------------------------------------------------------ asking linked machines who they can run

/** What one linked machine said last: its rows, or why it gave none (it's off for this, or didn't answer; anything else says nothing). */
interface Listed {
  at: number;
  rows: AskChoice[];
  problem: "off" | "down" | null;
}

export interface PeerListing {
  id: string;
  name: string;
  rows: AskChoice[];
  /** The plain line to show when the machine couldn't say, else null. */
  note: string | null;
}

export class PeerLists {
  private kept = new Map<string, Listed>();
  private going = new Map<string, Promise<Listed>>();
  /** The rows each machine last said, kept through a look that failed: a card's title needs the names even while the machine is silent. */
  private said = new Map<string, AskChoice[]>();

  constructor(private readonly app: App) {}

  private async ask(l: { id: string; url: string; token: string }, timeoutMs: number): Promise<Listed> {
    try {
      // With each row's models (newer than 0.6.1), so a model of that machine can be picked here; an older hub leaves them out.
      const data = await hubCall<unknown>(l.url, "/api/asks/peer-targets?models=1", { token: l.token, timeoutMs, raw: true });
      const rows = readPeerRows(data);
      this.said.set(l.id, rows);
      return { at: Date.now(), rows, problem: null };
    } catch (e) {
      const err = e as HttpError;
      // A hub that no longer takes this hub's sign-in is told so (as xchat does); one that's older than 0.5 or fails otherwise is just left out.
      if (err.status === 401) this.app.machines.signedOut(l.id);
      return { at: Date.now(), rows: [], problem: err.code === "off" ? "off" : down(err) ? "down" : null };
    }
  }

  /** One look at a machine, kept as what it said last. Whoever asks while one is under way shares it (one call each at most). */
  private look(l: { id: string; url: string; token: string }, timeoutMs: number): Promise<Listed> {
    let run = this.going.get(l.id);
    if (!run) {
      run = this.ask(l, timeoutMs)
        .then((got) => (this.kept.set(l.id, got), got))
        .finally(() => this.going.delete(l.id));
      this.going.set(l.id, run);
    }
    return run;
  }

  /**
   * What each linked machine (two-way links only: the others can't be called) can run. An answer is kept `keepMs`, a
   * failure too (so a machine that's off doesn't cost three seconds every time the sheet opens): `refresh` asks again,
   * `only` leaves the other machines out. Machines are asked at the same time, one call each at most, and none takes longer
   * than `timeoutMs`. One that didn't answer last time isn't waited for again once its word is old (it'd cost the sheet the
   * whole time limit on every opening while the machine is off): the old word stands, and it's asked again behind the scenes.
   */
  async list(o: { refresh?: boolean; only?: string; timeoutMs: number; keepMs: number }): Promise<PeerListing[]> {
    const links = this.app.machines.linked().filter((l) => l.agents === "two-way");
    for (const kept of [this.kept, this.said]) for (const id of [...kept.keys()]) if (!links.some((l) => l.id === id)) kept.delete(id);
    return Promise.all(
      links
        .filter((l) => !o.only || l.id === o.only)
        .map(async (l): Promise<PeerListing> => {
          let got = this.kept.get(l.id);
          const old = !got || Date.now() - got.at > o.keepMs;
          if (!got || o.refresh || (old && got.problem !== "down")) got = await this.look(l, o.timeoutMs);
          else if (old) void this.look(l, o.timeoutMs).catch(() => undefined);
          const name = line(l.name, 60) || "Another machine";
          return { id: l.id, name, rows: got.rows, note: got.problem === "off" ? turnedOff(name) : got.problem === "down" ? noAnswer(name) : null };
        }),
    );
  }

  /**
   * What a target was listed as on its machine (for its card's name), as of the last time that machine said, even if a look since
   * failed. Another of the row's models (picked in the sheet) is named as that machine names the account, with the model's own name.
   */
  /** Whether a target's machine last listed a model for it (null: it hasn't said which models it has). */
  lists(t: { provider: string; account: string; machine?: string | null }, model: string): boolean | null {
    const rows = ((t.machine && this.said.get(t.machine)) || []).filter((r) => r.target.provider === t.provider && r.target.account === t.account);
    if (!rows.some((r) => r.models)) return null;
    return rows.some((r) => r.models?.some((m) => m.id === model || m.resolvedModel === model));
  }

  nameOf(t: AskTarget): string | null {
    const rows = ((t.machine && this.said.get(t.machine)) || []).filter((r) => r.target.provider === t.provider && r.target.account === t.account);
    const same = rows.find((r) => t.model === null || r.target.model === t.model);
    if (same) return same.label;
    for (const r of rows) {
      const m = r.models?.find((x) => x.id === t.model || x.resolvedModel === t.model);
      if (m) return withModel(r.label, m.label);
    }
    return null;
  }
}

// ------------------------------------------------------------------------------------------------ answering another machine

const tooBig = () => new HttpError(413, "That's more than a linked machine may send to ask one question.", "too_long");

/** A request's body as text, refused (413) as soon as it passes `max` bytes: the header's word isn't trusted, the bytes are counted. */
export async function readCapped(req: Request, max: number): Promise<string> {
  const told = Number(req.headers.get("content-length"));
  if (Number.isFinite(told) && told > max) throw tooBig();
  const reader = req.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

/** A fresh, empty folder for one question from another machine (never a project's): `done` removes it. */
export function scratchFolder(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "crosstalk-peer-ask-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** An answer, cut where a linked machine's reply stops (the end says so). */
export const peerCut = (text: string) => (text.length > PEER_ANSWER ? `${text.slice(0, PEER_ANSWER)}\n…(cut short)` : text);
