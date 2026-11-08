// Ask others (docs/SPEC-0.4.md, track T1): a person asks other agents (any account and model on this hub) what they think of
// a message in a chat. Each question runs once, read-only, in a fresh agent process (oneshot.ts) that is given the chat up to
// that message as a note. The answer lands in a card under the message: a row in the `asks` table here, and `ask` events.
// Nothing of it enters the chat's own conversation. At most 3 run at once on the hub (the rest wait their turn), and a chat
// may have 6 waiting or running. A card goes with its message: unsend it, or rewind past it, and the question is stopped and
// taken away with it.
//
// 0.5 (docs/SPEC-0.5.md, T11): the people's other linked machines can be asked too. A target with `machine` is answered over
// the machine link (asksRemote.ts): this hub sends the same briefing to that hub's `POST /api/asks/peer`, which runs it there
// in an empty scratch folder, read-only, under that hub's own switches, caps and spending limits, and sends the answer back
// into a card here. Only linked hubs are ever called, by the address the link holds.

import { platform } from "node:os";
import type { Database } from "bun:sqlite";
import {
  CHAT_PROVIDERS,
  DEFAULT_ACCOUNT,
  PROVIDER_INFO,
  limitResetTime,
  memberAccount,
  type AgentAccount,
  type Ask,
  type AskChoice,
  type AskCost,
  type AskFixedModel,
  type AskMachineNote,
  type AskModel,
  type AskPick,
  type AskStatus,
  type AskTarget,
  type AskTargets,
  type ChatProvider,
  type CostBasis,
  type Device,
  type Member,
  type Message,
  type ModelCatalog,
  type ModelOption,
  type Room,
} from "@crosstalk/shared";
import type { AgentDriver } from "./agents/driver";
import type { LimitHit } from "./agents/limits";
import type { App } from "./app";
import {
  ACCOUNT,
  CODEX_ELSEWHERE,
  EFFORT,
  MODEL,
  PEER_BODY,
  PEER_CHARS,
  PEER_RATE,
  PeerLists,
  capital,
  peerCut,
  peerProblem,
  readCapped,
  readPeerAnswer,
  remoteHandle,
  scratchFolder,
  theMachine,
  withModel,
  type PeerAnswer,
  type PeerListing,
} from "./asksRemote";
import { ASK_QUESTION, agentLabel, askBriefing, askable, copiedMessages } from "./duplicate";
import { HttpError } from "./engine/engine";
import { hubCall } from "./machines";
import { ONE_SHOT_GRACE_MS, ONE_SHOT_MS, runOneShot, type OneShotResult, type OneShotUsage } from "./oneshot";
import { peerRoute, route, type Route } from "./routes";
import { newId } from "./util/ids";
import { logger } from "./util/log";

const log = logger("asks");

/**
 * An ask a usage limit stopped. An ask is one question about one message, so it doesn't carry itself on the way a chat
 * does (Turn.wait): it says plainly when that account comes back, and its card's Try again asks again.
 */
function limitAskWords(agent: string, limit: LimitHit): string {
  const when = limit.resetsAt && limit.resetsAt > Date.now() ? ` until ${limitResetTime(limit.resetsAt)}` : "";
  return `${agent} ${limit.kind === "rate" ? "has hit a rate limit" : "is out of messages"}${when}. Ask again ${when ? "then" : "in a while"}.`;
}

/** What the hub runs at once, how many a chat may have waiting, the cap on one question, and the grace after a stop. */
export interface AskLimits {
  running: number;
  pending: number;
  timeoutMs: number;
  graceMs: number;
}

const NOTE_MAX = 2_000;
const ANSWER_MAX = 30_000;
const RESTARTED = "Crosstalk restarted before this answered.";
/** What the briefing says the chat's folder is when the question goes to another machine (it can't open this one's folders). */
const ELSEWHERE = "a folder on another machine that you can't open";

/**
 * Newer than 0.6.1: the model and effort the person picked for each target in the sheet (kv, by `pickKey`), so the sheet opens on them
 * next time and an @name asks with them. Only the newest PICKS_MAX are kept.
 */
const PICKS = "asks.picks";
const PICKS_MAX = 200;
type KeptPick = AskPick & { at: number };
/** Which target a pick is for: the machine (empty for this one), the agent and the account; never the model, that's the pick. */
const pickKey = (t: { provider: string; account: string; machine?: string | null }) => `${t.machine ?? ""}|${t.provider}|${t.account}`;

/** A model list's entry for a model name, by the agent's own id or the full name behind it. */
const listedAs = <M extends Pick<ModelOption, "id" | "resolvedModel">>(models: readonly M[], model: string) => models.find((m) => m.id === model || m.resolvedModel === model);

/**
 * A pick as far as a model list still allows it: its model while the list has it (null, the default, always does) and its
 * effort while that model takes it. Null when the list no longer has its model: that pick isn't guessed at, the row is back on
 * its default (and says which, by name). `fallback` is the model a null pick stands for.
 */
function fitPick(pick: AskPick | null, models: readonly ModelOption[], fallback: ModelOption | undefined): AskPick | null {
  if (!pick) return null;
  const entry = pick.model ? listedAs(models, pick.model) : fallback;
  if (pick.model && !entry) return null;
  const effort = pick.effort && entry?.efforts.includes(pick.effort) ? pick.effort : null;
  return pick.model === null && effort === null ? null : { model: pick.model ? entry!.id : null, effort };
}

// ------------------------------------------------------------------------------------------------ the table

const SCHEMA = `CREATE TABLE IF NOT EXISTS asks (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  account TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  answer TEXT,
  error TEXT,
  cost_usd REAL,
  basis TEXT,
  in_tokens INTEGER NOT NULL DEFAULT 0,
  out_tokens INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  is_local INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  machine TEXT
);
CREATE INDEX IF NOT EXISTS asks_room ON asks(room_id, created_at)`;

/** Makes the table (no foreign key: a chat's asks are deleted with it by App.deleteRoom). deploy/restart-when-idle.sh reads it too. */
export function ensureAsks(db: Database) {
  db.exec(SCHEMA);
  // 0.5: which of the person's other machines answers (a table 0.4 made has no such column). A row with room `peer:<hub>` is a
  // question another machine asked of this one: it has no chat, and keeps the idle watcher from restarting the hub mid-answer.
  if (!(db.query("PRAGMA table_info(asks)").all() as { name: string }[]).some((c) => c.name === "machine")) db.exec("ALTER TABLE asks ADD COLUMN machine TEXT");
}

interface Row {
  id: string;
  room_id: string;
  message_id: string;
  provider: ChatProvider;
  account: string;
  model: string | null;
  effort: string | null;
  label: string;
  status: AskStatus;
  answer: string | null;
  error: string | null;
  cost_usd: number | null;
  basis: CostBasis | null;
  in_tokens: number;
  out_tokens: number;
  note: string | null;
  is_local: number;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  machine: string | null;
}

const toAsk = (r: Row): Ask => ({
  id: r.id,
  roomId: r.room_id,
  messageId: r.message_id,
  target: { provider: r.provider, account: r.account, model: r.model, effort: r.effort, ...(r.machine ? { machine: r.machine } : {}) },
  label: r.label,
  status: r.status,
  answer: r.answer,
  error: r.error,
  cost: r.basis ? { costUsd: r.cost_usd, basis: r.basis, inputTokens: r.in_tokens, outputTokens: r.out_tokens } : null,
  note: r.note,
  local: !!r.is_local,
  createdAt: r.created_at,
  startedAt: r.started_at,
  endedAt: r.ended_at,
});

// ------------------------------------------------------------------------------------------------ small pure things

/**
 * What to type after @ for an account's agent: the agent's own name for its main sign-in ("claude", "codex"), else a
 * short slug of the account's name ("kimi", "local-qwen"); never one already `taken` (the next gets "-2", "-3"...).
 */
export function askHandle(provider: ChatProvider, account: string, label: string, taken: ReadonlySet<string> = new Set()): string {
  const own = PROVIDER_INFO[provider].defaultHandle;
  const slug = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 24)
    .replace(/-+$/, "");
  const base = account === DEFAULT_ACCOUNT ? own : slug || own;
  let handle = base;
  for (let n = 2; taken.has(handle); n++) handle = `${base}-${n}`;
  return handle;
}

type ChatAccount = AgentAccount & { provider: ChatProvider };
const isChatAccount = (a: AgentAccount): a is ChatAccount => (CHAT_PROVIDERS as readonly string[]).includes(a.provider);

/** A model server on this very machine: what's asked of it never leaves. */
function onThisMachine(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "localhost" || host === "[::1]" || /^127\./.test(host);
  } catch {
    return false;
  }
}

const notInstalled = (provider: ChatProvider) => `${PROVIDER_INFO[provider].name} isn't installed on this machine. Install it, then ask again.`;

/** A limit as the sheet words it: "$250", "$12.50", "$1,500". */
const dollars = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;

/** An answer, cut at the most a card keeps. */
const capped = (text: string) => (text.length > ANSWER_MAX ? `${text.slice(0, ANSWER_MAX)}\n…(cut short)` : text);

const gave = (usage?: Partial<OneShotUsage>): OneShotResult => ({ ok: false, text: "", error: null, stopped: false, timedOut: false, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: null, ...usage } });

// ------------------------------------------------------------------------------------------------ the owner

export class Asks {
  readonly limits: AskLimits = { running: 3, pending: 6, timeoutMs: ONE_SHOT_MS, graceMs: ONE_SHOT_GRACE_MS };
  /** Another machine's list of who it can run: the time it gets to answer, and how long its answer (or its silence) is kept. */
  readonly peerLimits = { listMs: 3_000, keepMs: 30_000 };
  /** What the person's other linked machines say they can run. */
  private readonly peers: PeerLists;
  /** The questions being answered now: how to stop each, and a promise that ends when its agent has let go. */
  private live = new Map<string, { abort: AbortController; run: Promise<void> }>();
  /** Their agents' drivers, so a hub shutting down can end every process (the engine knows nothing of these). */
  private drivers = new Map<string, AgentDriver>();
  private closing = false;
  /** Stops listening for taken-back messages. */
  private unwatch: (() => void) | null = null;
  private readonly db: Database;

  constructor(private readonly app: App) {
    this.db = app.store.db;
    this.peers = new PeerLists(app);
    ensureAsks(this.db);
    // Questions a stopped hub left waiting or running can't go on: they say so (with Try again) rather than wait forever.
    this.endUnfinished();
    // The engine only says a message is gone (unsent, or rewound past); the questions about it go with it.
    this.unwatch = app.bus.on((e) => {
      if (e.t === "messages.removed") this.messagesRemoved(e.roomId, e.ids);
    });
  }

  private endUnfinished() {
    this.db.query("UPDATE asks SET status = 'error', error = ?, ended_at = ? WHERE status IN ('queued', 'running')").run(RESTARTED, Date.now());
  }

  /** Stops every ask still running and ends its agent process (the engine's shutdown knows nothing of one-shot drivers). */
  async shutdown(): Promise<void> {
    this.closing = true;
    this.unwatch?.();
    this.unwatch = null;
    const runs = [...this.live.values()];
    for (const l of runs) l.abort.abort();
    // Each agent is asked to stop; one that doesn't let go in a moment is ended with its process.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled(runs.map((l) => l.run)), new Promise((res) => (timer = setTimeout(res, Math.min(this.limits.graceMs, 3_000))))]);
    clearTimeout(timer);
    await Promise.allSettled([...this.drivers.values()].map((d) => d.dispose()));
    this.drivers.clear();
    try {
      this.endUnfinished();
    } catch (e) {
      log.debug(`ending unfinished asks: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** A chat was deleted: its asks go with it (a running one is stopped). */
  roomRemoved(roomId: string): void {
    for (const a of this.list(roomId)) this.live.get(a.id)?.abort.abort();
    this.db.query("DELETE FROM asks WHERE room_id = ?").run(roomId);
  }

  /** Messages were taken back (unsent, or rewound past): the questions about them go too, and one still running is stopped. */
  private messagesRemoved(roomId: string, ids: readonly string[]): void {
    const gone = new Set(ids);
    for (const a of this.list(roomId)) if (gone.has(a.messageId)) this.remove(a.id);
  }

  // ---------------------------------------------------------------------------------------------- reading

  private row(id: string): Row | null {
    return this.db.query("SELECT * FROM asks WHERE id = ?").get(id) as Row | null;
  }

  get(id: string): Ask | null {
    const r = this.row(id);
    return r ? toAsk(r) : null;
  }

  list(roomId: string): Ask[] {
    return (this.db.query("SELECT * FROM asks WHERE room_id = ? ORDER BY created_at, rowid").all(roomId) as Row[]).map(toAsk);
  }

  /** Changes a row and tells the apps. */
  private patch(id: string, p: Partial<Row>): Ask | null {
    const keys = Object.keys(p);
    if (!keys.length) return this.get(id);
    this.db.query(`UPDATE asks SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...(Object.values(p) as (string | number | null)[]), id);
    const ask = this.get(id);
    if (ask) this.app.bus.emit({ t: "ask", ask });
    return ask;
  }

  // ---------------------------------------------------------------------------------------------- who can be asked

  /** Why this account can't be asked now (`why` is short, for the sheet; `say` is the sentence a refusal gives), else null. */
  private unavailable(a: ChatAccount): { why: string; say: string; code: "not_signed_in" | "budget" } | null {
    const { app } = this;
    const name = agentLabel(app, a.provider, a.id);
    if (!app.providers.which(a.provider)) return { why: "Not installed", say: notInstalled(a.provider), code: "not_signed_in" };
    if (a.signedIn === false) return { why: "Not signed in", say: `${name} isn't signed in. Sign in under Settings → AI services, then ask again.`, code: "not_signed_in" };
    const limit = app.spend.checkBudget(a.provider, a.id);
    if (limit) {
      // The sheet's row is short ("Over its $250 limit"); a refusal says the spend module's whole sentence.
      const cap = app.spend.accounts().find((s) => s.provider === a.provider && s.account === a.id)?.budget?.limitUsd;
      return { why: typeof cap === "number" ? `Over its ${dollars(cap)} limit` : "Over its limit", say: limit, code: "budget" };
    }
    const full = app.store.getUsage(a.provider, a.id)?.windows.find((w) => (w.usedPercent ?? 0) >= 100 && (!w.resetsAt || w.resetsAt > Date.now()));
    if (full) {
      const back = full.resetsAt ? ` It comes back at ${limitResetTime(full.resetsAt)}.` : "";
      return { why: `Plan at 100% of its ${full.label} limit`, say: `${name}'s plan is at 100% of its ${full.label} limit.${back} Ask again after it resets, or pick another.`, code: "budget" };
    }
    return null;
  }

  /**
   * The model (and effort) an ask runs on: the one named, else the account's default from its model list. Never a guess:
   * null when there's neither (the list couldn't be read, or names no default). A model server's list is the one saved for
   * it, so its first model is its default even while the server isn't answering; `down` is then the plain reason why.
   */
  private async pick(a: ChatAccount, want: { model?: string | null; effort?: string | null }, known?: { catalog: ModelCatalog | null }) {
    const catalog = known ? known.catalog : await this.catalogOf(a);
    const saved = a.kind === "endpoint";
    const listed = want.model ? catalog?.models.find((m) => m.id === want.model || m.resolvedModel === want.model) : catalog?.live || saved ? catalog?.models.find((m) => m.isDefault) : undefined;
    const model = want.model || listed?.id;
    if (!model) return null;
    const down = saved && catalog && !catalog.live ? catalog.error || "Couldn't read its models" : null;
    return { model, effort: want.effort ?? listed?.defaultEffort ?? null, label: listed?.label ?? model, full: listed?.resolvedModel ?? model, down };
  }

  /** The card's title and the sheet's row: "Codex · GPT-5.5", "Kimi · kimi-k2", "Claude Code (Work) · Opus 5.5". */
  private labelOf(a: ChatAccount, model: string | null): string {
    const base = PROVIDER_INFO[a.provider].name;
    const agent = a.kind === "endpoint" ? a.label : a.id === DEFAULT_ACCOUNT ? base : `${base} (${a.label})`;
    return model ? `${agent} · ${model}` : agent;
  }

  /** Whether a paid price is known for this model (online services only: the spend module's price lists decide). */
  private priced(t: AskTarget): boolean {
    if (!t.model) return false;
    return !!this.app.spend.priceReply({ provider: t.provider, account: t.account, model: t.model, inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 0 }).costUsd;
  }

  /**
   * Whether an ask on a model of this account costs money: an API key's does, a plan's or a model on this machine's doesn't (nor
   * one more question on a flat monthly plan), an online service's once a price is known for that model.
   */
  private paidFor(a: ChatAccount, local: boolean, flat: boolean, model: string | null): AskChoice["paid"] {
    const kind = a.kind ?? "signin";
    if (kind === "apikey") return "yes";
    if (kind === "signin" || local || flat) return "no";
    return this.priced({ provider: a.provider, account: a.id, model, effort: null }) ? "yes" : "unknown";
  }

  /** What this target's finished asks cost on average (null: none priced yet, or it's free). */
  private typical(t: AskTarget): number | null {
    if (!t.model) return null;
    // An account's name means something else on each machine: a machine's asks are counted apart.
    const r = this.db.query("SELECT AVG(cost_usd) AS avg FROM asks WHERE provider = ? AND account = ? AND model = ? AND COALESCE(machine, '') = ? AND status = 'done' AND cost_usd IS NOT NULL AND basis != 'free'").get(t.provider, t.account, t.model, t.machine ?? "") as { avg: number | null };
    return r.avg;
  }

  /** The same figure for every model of an account at once: model to what its finished asks cost on average. */
  private typicalByModel(t: { provider: string; account: string; machine?: string | null }): Map<string, number> {
    const rows = this.db
      .query("SELECT model, AVG(cost_usd) AS avg FROM asks WHERE provider = ? AND account = ? AND model IS NOT NULL AND COALESCE(machine, '') = ? AND status = 'done' AND cost_usd IS NOT NULL AND basis != 'free' GROUP BY model")
      .all(t.provider, t.account, t.machine ?? "") as { model: string; avg: number | null }[];
    return new Map(rows.flatMap((r) => (r.avg === null ? [] : [[r.model, r.avg] as const])));
  }

  /** An account's model list, the one every model picker shows (null when it couldn't be had at all). */
  private catalogOf(a: ChatAccount): Promise<ModelCatalog | null> {
    return this.app.providers.models(a.provider, a.id).catch(() => null);
  }

  /**
   * The models a row offers in the sheet (newer than 0.6.1): its live list as it is (each model's context, "No tools" mark and effort
   * levels, as every model picker shows them), each with whether an ask on it costs money and what one usually costs.
   */
  private offered(a: ChatAccount, models: readonly ModelOption[], local: boolean, flat: boolean): AskModel[] {
    const typical = this.typicalByModel({ provider: a.provider, account: a.id });
    return models.map((m) => ({ ...m, paid: this.paidFor(a, local, flat, m.id), typicalCostUsd: typical.get(m.id) ?? null }));
  }

  // ---------------------------------------------------------------------------------------------- the person's picks (newer than 0.6.1)

  /** The picks kept from the sheet, by target (`pickKey`). */
  private picks(): Record<string, KeptPick> {
    try {
      const all = JSON.parse(this.app.store.kvGet(PICKS) ?? "{}") as unknown;
      return all && typeof all === "object" && !Array.isArray(all) ? (all as Record<string, KeptPick>) : {};
    } catch {
      return {};
    }
  }

  /** The pick kept for one target (an entry that doesn't hold names is none). */
  private pickOf(all: Record<string, KeptPick>, t: { provider: string; account: string; machine?: string | null }): AskPick | null {
    const p = all[pickKey(t)] as Partial<KeptPick> | undefined;
    const model = typeof p?.model === "string" && MODEL.test(p.model) ? p.model : null;
    const effort = typeof p?.effort === "string" && EFFORT.test(p.effort) ? p.effort : null;
    return model || effort ? { model, effort } : null;
  }

  /**
   * Keeps what the sheet picked for the targets of a request it made (`memos`: one per target, the pick as the sheet showed it,
   * null for a default), so the sheet opens on it next time and an @name asks with it. Only a target this request asked counts,
   * and a name that doesn't look like one is passed over. Picking the defaults again forgets the pick (the row follows its
   * default from then on, whatever that becomes) — unless the kept model just isn't on its list right now: the row was on its
   * default only for that (an update dropped the model, Claude Code checks it again), and the pick comes back with the model.
   * Nothing here starts anything or asks any agent.
   */
  private async keepPicks(memos: unknown, asked: readonly AskTarget[]) {
    if (!Array.isArray(memos) || !memos.length) return;
    const picks: { key: string; target: { provider: string; account: string; machine: string | null }; model: string | null; effort: string | null }[] = [];
    for (const raw of memos.slice(0, 20)) {
      const m = (raw ?? {}) as Record<string, unknown>;
      const target = { provider: String(m.provider), account: String(m.account), machine: typeof m.machine === "string" ? m.machine : null };
      const key = pickKey(target);
      if (!asked.some((t) => pickKey(t) === key)) continue;
      const model = m.model == null ? null : typeof m.model === "string" && MODEL.test(m.model) ? m.model : undefined;
      const effort = m.effort == null ? null : typeof m.effort === "string" && EFFORT.test(m.effort) ? m.effort : undefined;
      if (model === undefined || effort === undefined) continue;
      picks.push({ key, target, model, effort });
    }
    // The defaults keep a pick whose model isn't on its list right now. Looked at first, so the picks are read and written
    // with nothing in between (another request may keep picks meanwhile).
    const stays = new Set<string>();
    for (const p of picks) {
      const kept = p.model === null && p.effort === null ? this.pickOf(this.picks(), p.target)?.model : null;
      if (kept && !(await this.listsModel(p.target, kept))) stays.add(p.key);
    }
    const all = this.picks();
    const now = Date.now();
    let changed = false;
    for (const { key, model, effort } of picks) {
      if (stays.has(key)) continue;
      if (model === null && effort === null) {
        changed ||= key in all;
        delete all[key];
      } else {
        all[key] = { model, effort, at: now };
        changed = true;
      }
    }
    if (!changed) return;
    const kept = Object.entries(all)
      .filter(([, p]) => p && typeof p === "object")
      .sort((x, y) => (Number(y[1].at) || 0) - (Number(x[1].at) || 0))
      .slice(0, PICKS_MAX);
    this.app.store.kvSet(PICKS, JSON.stringify(Object.fromEntries(kept)));
  }

  /**
   * Whether a target's list has a model right now: the same list a kept pick is held against when the sheet opens
   * (`choices`), or what its machine last said (a machine that hasn't said: no).
   */
  private async listsModel(t: { provider: string; account: string; machine: string | null }, model: string): Promise<boolean> {
    if (t.machine) return this.peers.lists(t, model) ?? false;
    const a = this.app.providers.accounts().filter(isChatAccount).find((x) => x.provider === t.provider && x.id === t.account);
    const catalog = a ? await this.catalogOf(a) : null;
    const models = a && catalog && (catalog.live || a.kind === "endpoint") ? catalog.models : [];
    return !!listedAs(models, model);
  }

  /** Who can be asked about a message in this chat, and why not when someone can't: what runs here, then what runs on the person's other linked machines. */
  async targets(roomId: string, opts: { refresh?: boolean; models?: boolean } = {}): Promise<AskChoice[]> {
    return (await this.targetsFor(roomId, opts)).choices;
  }

  /**
   * The same, with the linked machines that couldn't say ("The PC didn't answer.") apart. `refresh` asks every machine again
   * instead of using what it said lately; `machines: false` leaves the other machines out (and doesn't wait for them);
   * `models` gives each row that can be asked the models the sheet offers for it (newer than 0.6.1). Each row is on the model and effort
   * the person last picked for it in the sheet, while its list still has that model, so an @name asks with that pick too.
   */
  async targetsFor(roomId: string, opts: { refresh?: boolean; machines?: boolean; models?: boolean } = {}): Promise<AskTargets> {
    const { app } = this;
    const room = app.store.getRoom(roomId);
    if (!room) throw new HttpError(404, "room not found");
    if (!room.chat) throw new HttpError(400, "Ask others works in chats.");
    // A group chat's agents are in it already: the others are offered.
    const choices = await this.choices(app.store.listMembers(roomId), { models: opts.models, remembered: true });
    const machines: AskMachineNote[] = [];
    const taken = new Set(choices.map((c) => c.handle));
    // A machine that fails, or is older than 0.5, adds nothing (and never slows this: each gets a few seconds, together).
    const listed = opts.machines === false ? [] : await this.peers.list({ refresh: opts.refresh, timeoutMs: this.peerLimits.listMs, keepMs: this.peerLimits.keepMs }).catch(() => []);
    const picks = listed.length ? this.picks() : {};
    for (const l of listed) {
      if (l.note) machines.push({ id: l.id, name: l.name, why: l.note });
      for (const r of l.rows) {
        const handle = remoteHandle(r.handle, l.name, taken);
        taken.add(handle);
        choices.push(this.remoteChoice(r, l, handle, picks, !!opts.models));
      }
    }
    return { choices, machines };
  }

  /**
   * A row another machine listed, as this machine's sheet and @ popup show it: named with where it runs, its typical costs
   * counted from this machine's own asks of it, and on the person's last pick for it here while that machine still lists that
   * model. `withModels`: the sheet wants its models for the picker, or why it can't have them (a model pool runs one model; a
   * Crosstalk there of 0.6.1 or older sends none, and takes no pick).
   */
  private remoteChoice(r: AskChoice, l: PeerListing, handle: string, picks: Record<string, KeptPick>, withModels: boolean): AskChoice {
    let target: AskTarget = { ...r.target, machine: l.id };
    // An account's name means something else on each machine: what its asks cost here is counted per machine.
    const typical = r.available && r.models ? this.typicalByModel(target) : null;
    const models = r.models && typical ? r.models.map((m) => ({ ...m, typicalCostUsd: typical.get(m.id) ?? m.typicalCostUsd })) : undefined;
    // What a pick of its default stands for: the model that machine would use (its row's), else the one its list marks.
    const fallback = models && ((r.target.model ? listedAs(models, r.target.model) : undefined) ?? models.find((m) => m.isDefault));
    const remembered = models && !r.fixedModel ? fitPick(this.pickOf(picks, target), models, fallback) : null;
    let { label, paid } = r;
    let typicalCostUsd = this.typical(target) ?? r.typicalCostUsd;
    const entry = remembered && models ? (remembered.model ? listedAs(models, remembered.model) : fallback) : undefined;
    if (remembered && entry) {
      target = { ...target, model: entry.id, effort: remembered.effort ?? entry.defaultEffort ?? null };
      label = withModel(r.label, entry.label);
      paid = entry.paid;
      typicalCostUsd = entry.typicalCostUsd;
    }
    const row: AskChoice = {
      target,
      // The name says where it is; what the machine itself calls "this machine" would read wrongly here.
      label: `${label} · on ${theMachine(l.name)}`,
      sub: r.local ? "" : r.sub,
      handle,
      paid,
      local: r.local,
      available: r.available,
      why: r.why,
      typicalCostUsd,
      machine: { id: l.id, name: l.name },
      ...(remembered && entry ? { remembered } : {}),
    };
    if (withModels && r.available) {
      const fixed: AskFixedModel | null = r.fixedModel ?? (models ? null : "update");
      if (fixed) row.fixedModel = fixed;
      else row.models = models;
    }
    return row;
  }

  /**
   * Who a linked machine may ask here (GET /api/asks/peer-targets): every account as for a chat, the chat's own agent included,
   * each on its default (the asking machine keeps its person's picks itself), and with `models` the models each can be asked on.
   * Codex's rows are greyed (CODEX_ELSEWHERE).
   */
  async peerTargets(opts: { models?: boolean } = {}): Promise<AskChoice[]> {
    this.peerGate();
    return (await this.choices([], { models: opts.models })).map((r) => {
      if (r.target.provider !== "codex") return r;
      const { models: _none, fixedModel: _fixed, ...row } = r;
      return { ...row, available: false, why: CODEX_ELSEWHERE };
    });
  }

  /**
   * What this machine can run as a one-shot, a row each. `own` (a chat's agents) aren't offered, unless another model of theirs
   * would answer. `models`: each row that can be asked says the models it can be asked on (the sheet's picker), or why it can't
   * be picked (`fixedModel`). `remembered`: a row is on the person's last pick for it, while its list still has that model.
   */
  private async choices(own: readonly Member[], opts: { models?: boolean; remembered?: boolean } = {}): Promise<AskChoice[]> {
    const accounts = this.app.providers.accounts().filter(isChatAccount);
    // The main sign-ins take the plain handles (claude, codex) before an extra account's name is turned into one.
    const taken = new Set<string>();
    const handles = new Map<ChatAccount, string>();
    for (const a of [...accounts.filter((x) => x.id === DEFAULT_ACCOUNT), ...accounts.filter((x) => x.id !== DEFAULT_ACCOUNT)]) {
      const handle = askHandle(a.provider, a.id, a.label, taken);
      taken.add(handle);
      handles.set(a, handle);
    }
    const picks = opts.remembered ? this.picks() : {};
    const rows = await Promise.all(
      accounts.map(async (a): Promise<AskChoice | null> => {
        const gone = this.unavailable(a);
        // Its model list is only asked for when the agent is there to ask (nothing is started for one that isn't signed in).
        const listing = !gone || gone.code === "budget";
        const catalog = listing ? await this.catalogOf(a) : null;
        // A list a pick can be held against (and the sheet offers): the agent's own answer, or a model server's saved list.
        const models = catalog && (catalog.live || a.kind === "endpoint") ? catalog.models : [];
        // The model pool runs the one model it was started with: there's no other to pick (pool/pool.ts).
        const pool = this.app.pool.servesMember({ provider: a.provider, config: { account: a.id } });
        // The person's last pick for it, while its list still has that model (and that model still takes that effort). Not for
        // the chat's own agent: whether it's offered at all stays as it was, so "@codex" in a Codex chat still means what it did.
        const mine = own.some((o) => o.provider === a.provider && memberAccount(o) === a.id);
        const remembered = pool || mine ? null : fitPick(this.pickOf(picks, { provider: a.provider, account: a.id }), models, models.find((m) => m.isDefault));
        const picked = listing ? await this.pick(a, remembered ?? {}, { catalog }) : null;
        // The chat's own agent isn't offered, unless another model of it would answer.
        if (own.some((o) => o.provider === a.provider && memberAccount(o) === a.id && (!picked || !o.model || o.model === picked.model || o.model === picked.full))) return null;
        const target: AskTarget = { provider: a.provider, account: a.id, model: picked?.model ?? null, effort: picked?.effort ?? null };
        const kind = a.kind ?? "signin";
        const local = kind === "endpoint" && onThisMachine(a.endpoint?.baseUrl ?? "");
        // A key on a flat monthly plan pays nothing for one more question (Featherless's Chat plan): "no", not a price
        // list's guess at what its model would cost somewhere else (hub/src/featherless.ts flatRate).
        const flat = kind === "endpoint" && this.app.services.flatRate(a.provider, a.id, a.endpoint?.baseUrl);
        const why = gone?.why ?? (picked ? picked.down : "Couldn't read its models");
        const row: AskChoice = {
          target,
          label: this.labelOf(a, picked?.label ?? null),
          sub: kind === "apikey" ? "API key" : kind === "signin" ? "Plan" : local ? (platform() === "darwin" ? "On this Mac" : "On this machine") : "Online",
          handle: handles.get(a)!,
          paid: this.paidFor(a, local, flat, target.model),
          local,
          available: !why,
          why,
          typicalCostUsd: this.typical(target),
          ...(remembered && picked ? { remembered } : {}),
        };
        // The sheet's model picker: only a row that can be asked has one.
        if (opts.models && !why) {
          if (pool) row.fixedModel = "pool";
          else row.models = this.offered(a, models, local, flat);
        }
        return row;
      }),
    );
    return rows.filter((r): r is AskChoice => !!r);
  }

  // ---------------------------------------------------------------------------------------------- asking

  /** One target of a request, checked and filled in: its account, its model (the one named, else the account's default) and effort. */
  private async resolve(t: AskTarget): Promise<{ target: AskTarget; label: string; local: boolean }> {
    if (!t || !(CHAT_PROVIDERS as readonly string[]).includes(t.provider)) throw new HttpError(400, "You can ask Claude Code or Codex.");
    const id = typeof t.account === "string" && t.account ? t.account : DEFAULT_ACCOUNT;
    const a = this.app.providers.accounts().filter(isChatAccount).find((x) => x.provider === t.provider && x.id === id);
    if (!a) {
      // An agent that isn't installed has no main account to list.
      if (id === DEFAULT_ACCOUNT && !this.app.providers.which(t.provider)) throw new HttpError(409, notInstalled(t.provider), "not_signed_in");
      throw new HttpError(404, "That account isn't on this machine.");
    }
    const gone = this.unavailable(a);
    if (gone) throw new HttpError(409, gone.say, gone.code);
    if (t.model != null && !(typeof t.model === "string" && MODEL.test(t.model))) throw new HttpError(400, "That model name doesn't look right.");
    if (t.effort != null && !(typeof t.effort === "string" && EFFORT.test(t.effort))) throw new HttpError(400, "That effort level doesn't look right.");
    const picked = await this.pick(a, { model: t.model, effort: t.effort });
    if (!picked) throw new HttpError(409, `${agentLabel(this.app, a.provider, a.id)} has no default model to ask. Check its sign-in under Settings → AI services, then try again.`, "model_choice");
    const target: AskTarget = { provider: a.provider, account: a.id, model: picked.model, effort: picked.effort };
    return { target, label: this.labelOf(a, picked.label), local: a.kind === "endpoint" && onThisMachine(a.endpoint?.baseUrl ?? "") };
  }

  /** One target on another linked machine, checked as far as this machine can (that machine checks the rest when it answers). */
  private async resolveRemote(t: AskTarget): Promise<{ target: AskTarget; label: string; local: false }> {
    const link = this.app.machines.linkOf(String(t.machine));
    if (!link) throw new HttpError(404, "That machine isn't linked with this one any more. Check Settings → Machines, then ask again.");
    if (link.agents !== "two-way") throw new HttpError(409, `${capital(theMachine(link.name))} isn't connected for this yet. Check Settings → Machines, then ask again.`);
    if (!(CHAT_PROVIDERS as readonly string[]).includes(t.provider)) throw new HttpError(400, "You can ask Claude Code or Codex.");
    if (t.account != null && !(typeof t.account === "string" && ACCOUNT.test(t.account))) throw new HttpError(400, "That account name doesn't look right.");
    if (t.model != null && !(typeof t.model === "string" && MODEL.test(t.model))) throw new HttpError(400, "That model name doesn't look right.");
    if (t.effort != null && !(typeof t.effort === "string" && EFFORT.test(t.effort))) throw new HttpError(400, "That effort level doesn't look right.");
    const target: AskTarget = { provider: t.provider, account: t.account || DEFAULT_ACCOUNT, model: t.model ?? null, effort: t.effort ?? null, machine: link.id };
    // The card is titled as that machine calls it ("Qwen3 · qwen3-30b"): from the last time it said, else (after a restart) from one
    // look at it, within the time the sheet's list gets.
    let name = this.peers.nameOf(target);
    if (!name) {
      await this.peers.list({ only: link.id, timeoutMs: this.peerLimits.listMs, keepMs: this.peerLimits.keepMs }).catch(() => undefined);
      name = this.peers.nameOf(target);
    }
    // Still unknown: the model, on its machine. The program that would run it ("Claude Code" for a model server's Qwen3) isn't what it
    // is, so only a main sign-in is named after its program.
    name ??= [target.account === DEFAULT_ACCOUNT ? PROVIDER_INFO[target.provider].name : null, target.model].filter(Boolean).join(" · ") || target.account;
    return { target, label: `${name} · on ${theMachine(link.name)}`, local: false };
  }

  /**
   * Asks each target about a message. Refuses the whole request (with a way out) when any target can't be asked. `remember`
   * (newer than 0.6.1, the sheet's): the picks to keep for next time, one per target asked; kept only once the request was accepted.
   */
  async start(input: { roomId: string; messageId: string; targets: AskTarget[]; note?: string | null; remember?: unknown }): Promise<Ask[]> {
    const { app, limits } = this;
    const room = app.store.getRoom(String(input.roomId ?? ""));
    if (!room) throw new HttpError(404, "That chat isn't on this machine any more.");
    if (!room.chat) throw new HttpError(400, "Ask others works in chats.");
    const message = app.store.getMessage(String(input.messageId ?? ""));
    if (!message || message.roomId !== room.id) throw new HttpError(404, "That message isn't in this chat any more.");
    if (message.status === "streaming") throw new HttpError(409, "That reply is still being written. Ask once it's done.", "busy");
    if (!askable(message)) throw new HttpError(400, "Ask about a message from you or from the agent, with some text in it.");
    const picks = Array.isArray(input.targets) ? input.targets : [];
    if (!picks.length) throw new HttpError(400, "Pick who to ask.");
    const note = (typeof input.note === "string" ? input.note.trim().slice(0, NOTE_MAX) : "") || null;
    const plan = await Promise.all(picks.map((t) => (t && t.machine != null ? this.resolveRemote(t) : this.resolve(t))));
    const waiting = (this.db.query("SELECT COUNT(*) AS n FROM asks WHERE room_id = ? AND status IN ('queued', 'running')").get(room.id) as { n: number }).n;
    if (waiting + plan.length > limits.pending) throw new HttpError(409, `This chat already has ${waiting} ${waiting === 1 ? "question" : "questions"} waiting. Let some finish or remove them, then ask again.`, "busy");
    const now = Date.now();
    const ids = plan.map((p) => {
      const id = newId("ask");
      this.db
        .query("INSERT INTO asks (id, room_id, message_id, provider, account, model, effort, label, status, note, is_local, created_at, machine) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)")
        .run(id, room.id, message.id, p.target.provider, p.target.account, p.target.model, p.target.effort, p.label, note, p.local ? 1 : 0, now, p.target.machine ?? null);
      app.bus.emit({ t: "ask", ask: this.get(id)! });
      return id;
    });
    try {
      await this.keepPicks(input.remember, plan.map((p) => p.target));
    } catch (e) {
      log.warn(`couldn't keep the sheet's picks: ${e instanceof Error ? e.message : e}`);
    }
    this.pump();
    return ids.map((id) => this.get(id)!);
  }

  /** Starts waiting questions, oldest first, while there's room for them. */
  private pump() {
    while (!this.closing && this.live.size < this.limits.running) {
      const next = this.db.query("SELECT * FROM asks WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1").get() as Row | null;
      if (!next) return;
      this.begin(next);
    }
  }

  private begin(row: Row) {
    const abort = new AbortController();
    const entry = { abort, run: Promise.resolve() };
    this.live.set(row.id, entry);
    const ask = this.patch(row.id, { status: "running", started_at: Date.now() })!;
    entry.run = this.execute(ask, abort)
      .catch((e) => log.warn(`an ask ended badly: ${e instanceof Error ? e.message : e}`))
      .finally(() => {
        this.live.delete(row.id);
        this.drivers.delete(row.id);
        this.pump();
      });
  }

  /** Runs one question to its end and keeps what came of it. Never throws. */
  private async execute(ask: Ask, abort: AbortController) {
    const { app } = this;
    const { provider, account, model, effort, machine } = ask.target;
    try {
      const room = app.store.getRoom(ask.roomId);
      const members = app.store.listMembers(ask.roomId);
      const member = members[0];
      const asked = app.store.getMessage(ask.messageId);
      // The limit may have been used up while it waited (one on another machine is that machine's to check).
      const limit = machine ? null : app.spend.checkBudget(provider, account);
      if (limit) return this.finish(ask, gave(), limit);
      if (!room || !member || !asked || !askable(asked)) return this.finish(ask, gave(), "That message was taken back before this could start.");
      // The chat up to that message (not the steps), with the message itself last.
      const messages = app.store.listMessages(room.id, { beforeSeq: app.store.messageSeq(asked.id) + 1, limit: 200 });
      // Each reply is labelled with the agent that wrote it (a group chat has several).
      const agentOf = (m: Message) => {
        const who = members.find((x) => x.id === m.memberId) ?? member;
        return { agent: agentLabel(app, who.provider, memberAccount(who)), provider: who.provider };
      };
      const systemNote = askBriefing(copiedMessages(messages, agentOf, messages.length - 1), machine ? ELSEWHERE : room.cwd);
      if (machine) return await this.executeRemote(ask, abort, systemNote);
      const result = await runOneShot(app, {
        room,
        provider,
        account,
        model,
        effort,
        prompt: ask.note || ASK_QUESTION,
        systemNote,
        signal: abort.signal,
        timeoutMs: this.limits.timeoutMs,
        graceMs: this.limits.graceMs,
        onDriver: (d) => this.drivers.set(ask.id, d),
      });
      this.finish(ask, result);
    } catch (e) {
      this.finish(ask, gave(), `${this.whoOf(ask)} couldn't answer: ${e instanceof Error ? e.message : e}.`);
    }
  }

  /** Who answers a card, as its sentences say it: "Codex", or "Codex on the PC" for one on another machine. */
  private whoOf(ask: Ask): string {
    const { provider, account, machine } = ask.target;
    if (!machine) return agentLabel(this.app, provider, account);
    const name = this.app.machines.linkOf(machine)?.name;
    return `${ask.label.split(" · ")[0]} on ${name ? theMachine(name) : "another machine"}`;
  }

  /** Sends the question to the linked machine that answers it, and keeps what comes back. Never throws. */
  private async executeRemote(ask: Ask, abort: AbortController, systemNote: string) {
    const { target } = ask;
    const link = this.app.machines.linkOf(target.machine!);
    if (!link || link.agents !== "two-way") return this.finish(ask, gave(), `${link ? capital(theMachine(link.name)) : "That machine"} isn't connected for this any more. Check Settings → Machines, then Try again.`, { cost: null });
    let data: unknown;
    try {
      // The other hub stops at the time cap itself; this call waits a little longer than that, then gives up.
      const wait = this.limits.timeoutMs + this.limits.graceMs + Math.min(15_000, this.limits.timeoutMs);
      const body = { target: { provider: target.provider, account: target.account, model: target.model, effort: target.effort }, systemNote, prompt: ask.note || ASK_QUESTION };
      data = await hubCall<unknown>(link.url, "/api/asks/peer", { method: "POST", token: link.token, body, timeoutMs: wait, signal: abort.signal, raw: true });
    } catch (e) {
      // Stopped by the person (or the hub is shutting down): the call is cancelled, and the other hub sees the connection close.
      if (abort.signal.aborted) return this.finish(ask, { ...gave(), stopped: true }, undefined, { cost: null });
      if ((e as HttpError).status === 401) this.app.machines.signedOut(link.id);
      return this.finish(ask, gave(), peerProblem(e, link.name, link.url), { cost: null });
    }
    const a = readPeerAnswer(data);
    if (!a) return this.finish(ask, gave(), `${capital(theMachine(link.name))} sent back something Crosstalk couldn't read. Try again.`, { cost: null });
    const used = a.usage.inputTokens > 0 || a.usage.outputTokens > 0 || (a.usage.costUsd ?? 0) > 0;
    // The figure is that machine's (its ledger has the spend); the card shows it as it said it.
    const cost: AskCost | null = (a.ok && !!a.text) || used ? { costUsd: a.usage.costUsd, basis: a.usage.basis, inputTokens: a.usage.inputTokens, outputTokens: a.usage.outputTokens } : null;
    this.finish(ask, { ok: a.ok, text: a.text, error: a.error, stopped: a.stopped, timedOut: a.timedOut, usage: a.usage }, undefined, { cost });
  }

  /** What the question cost, and how sure that is. */
  private costOf(t: Pick<AskTarget, "provider" | "account" | "model">, local: boolean, u: OneShotUsage): AskCost {
    const { provider, account, model } = t;
    const saved = this.app.providers.accounts().find((a) => a.provider === provider && a.id === account);
    const kind = saved?.kind ?? "signin";
    const tokens = { inputTokens: u.inputTokens, outputTokens: u.outputTokens };
    if (local) return { ...tokens, costUsd: 0, basis: "free" };
    // A key on one flat fee for the month, so this question added nothing to it: the ledger keeps the same figure (spend.ts).
    if (kind === "endpoint" && this.app.services.flatRate(provider, account, saved?.endpoint?.baseUrl)) return { ...tokens, costUsd: 0, basis: "plan" };
    const none = !u.inputTokens && !u.outputTokens && u.costUsd === null;
    // A fresh Claude Code process's own figure is exact, except on a model server (it would price the name it sees as Anthropic's).
    const priced = none
      ? { costUsd: null, basis: "unknown" as CostBasis }
      : provider === "claude" && kind !== "endpoint" && u.costUsd !== null
        ? { costUsd: u.costUsd, basis: "exact" as CostBasis }
        : this.app.spend.priceReply({ provider, account, model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, cachedTokens: u.cachedInputTokens });
    // A plan sign-in isn't billed: its figure is what the use would cost.
    return { ...tokens, costUsd: priced.costUsd, basis: kind === "signin" ? "plan" : priced.basis };
  }

  /**
   * Keeps how a question ended: its answer or what went wrong, and its cost (also in the spend ledger). One answered on another
   * machine (`theirs`) is that machine's spend: its figure is on the card, and this hub's ledger, whose accounts those aren't, has none.
   */
  private finish(ask: Ask, r: OneShotResult, plain?: string, theirs?: { cost: AskCost | null }) {
    const { app } = this;
    const { provider, account, model } = ask.target;
    const agent = this.whoOf(ask);
    const answered = r.ok && !!r.text;
    const used = r.usage.inputTokens > 0 || r.usage.outputTokens > 0 || (r.usage.costUsd ?? 0) > 0;
    const cost = theirs ? theirs.cost : answered || used ? this.costOf(ask.target, ask.local, r.usage) : null;
    if (cost && !theirs) {
      try {
        app.spend.record({ source: "ask", provider, account, roomId: ask.roomId, chatName: app.store.getRoom(ask.roomId)?.name ?? null, askId: ask.id, model, inputTokens: cost.inputTokens, outputTokens: cost.outputTokens, cachedTokens: r.usage.cachedInputTokens, costUsd: cost.costUsd, basis: cost.basis });
      } catch (e) {
        log.warn(`couldn't keep an ask's cost: ${e instanceof Error ? e.message : e}`);
      }
    }
    const row = this.row(ask.id);
    if (!row) return; // taken away meanwhile (removed, or its chat was deleted)
    const changes: Partial<Row> = cost ? { cost_usd: cost.costUsd, basis: cost.basis, in_tokens: cost.inputTokens, out_tokens: cost.outputTokens } : {};
    // What the agent had written when it was stopped (by the person, or at the time cap) is kept: it may well be worth reading.
    if ((r.stopped || r.timedOut) && !this.closing && r.text) changes.answer = capped(r.text);
    // Stopped by the person: already marked so, it only gets its cost (and what was written).
    if (row.status === "running") {
      const minutes = Math.max(1, Math.round(this.limits.timeoutMs / 60_000));
      const reason = (r.error ?? "it stopped without saying why").replace(/[.\s]+$/, "");
      Object.assign(changes, { ended_at: Date.now() });
      if (this.closing) Object.assign(changes, { status: "error", error: RESTARTED });
      else if (plain) Object.assign(changes, { status: "error", error: plain });
      else if (answered) Object.assign(changes, { status: "done", answer: capped(r.text) });
      else if (r.ok) Object.assign(changes, { status: "error", error: `${agent} finished without writing an answer.` });
      else if (r.timedOut) Object.assign(changes, { status: "error", error: `${agent} took longer than ${minutes} ${minutes === 1 ? "minute" : "minutes"}, so Crosstalk stopped it.` });
      else if (r.stopped) Object.assign(changes, { status: "stopped" });
      // A usage limit, not a fault: plain words and when that account comes back (the card already offers Try again).
      else if (r.limit) Object.assign(changes, { status: "error", error: limitAskWords(agent, r.limit) });
      else Object.assign(changes, { status: "error", error: `${agent} couldn't answer: ${reason}.` });
    }
    this.patch(ask.id, changes);
  }

  /** Stops a question (waiting or running); one already over is left as it is. */
  stop(id: string): Ask {
    const ask = this.get(id);
    if (!ask) throw new HttpError(404, "That question is gone.");
    if (ask.status !== "queued" && ask.status !== "running") return ask;
    const stopped = this.patch(id, { status: "stopped", ended_at: Date.now() })!;
    this.live.get(id)?.abort.abort();
    return stopped;
  }

  /** Takes a card away (a question still going is stopped first). */
  remove(id: string): { ok: true } {
    const ask = this.get(id);
    if (ask) {
      this.live.get(id)?.abort.abort();
      this.db.query("DELETE FROM asks WHERE id = ?").run(id);
      this.app.bus.emit({ t: "ask.removed", id, roomId: ask.roomId });
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------------------------------------- questions from other machines

  /** Whether linked machines may use this machine's agents (Settings → Agents across chats), and the way out when not. */
  peerGate() {
    if (!this.app.hubSettings().agentsAcrossChats) throw new HttpError(403, `Turn on Agents across chats on ${this.app.machineName()} in Settings, then ask again.`, "off");
  }

  /**
   * A linked machine's question (POST /api/asks/peer), answered here: the account, model, sign-in and spending limit are this
   * machine's own (`resolve`, as for a person's ask), and so are the caps (3 questions running at once on this hub, 3 minutes,
   * 20 questions from one machine in 10 minutes). It runs read-only in a fresh empty folder that's removed afterwards, never in a
   * project. Nothing is kept as a chat, message or turn; its cost goes in the ledger as an ask from that machine, and a row in
   * `asks` (room `peer:<hub>`) shows the idle watcher it's running. `gone` aborts when the asking machine hangs up (its Stop).
   */
  async peerAsk(caller: PeerCaller, body: unknown, gone: AbortSignal): Promise<PeerAnswer> {
    const { app, limits } = this;
    this.peerGate();
    const b = (body ?? {}) as { target?: Partial<AskTarget> | null; systemNote?: unknown; prompt?: unknown };
    const prompt = typeof b.prompt === "string" ? b.prompt.trim() : "";
    const systemNote = typeof b.systemNote === "string" ? b.systemNote : "";
    if (!prompt) throw new HttpError(400, "There's no question to ask.");
    if (prompt.length + systemNote.length > PEER_CHARS) throw new HttpError(413, `That's more than ${PEER_CHARS.toLocaleString("en-US")} characters, the most one question from another machine can hold.`, "too_long");
    const t = b.target;
    if (!t || typeof t !== "object") throw new HttpError(400, "Say who to ask.");
    // Codex can read any file here whatever folder it starts in (see CODEX_ELSEWHERE), so a stranger's question never reaches it.
    if (t.provider === "codex") throw new HttpError(409, `${CODEX_ELSEWHERE}. Pick someone else.`, "local_only");
    if (this.closing) throw new HttpError(503, `${app.machineName()} is shutting down. Try again in a moment.`, "busy");
    const room = `peer:${caller.hubId}`;
    const recent = (this.db.query("SELECT COUNT(*) AS n FROM asks WHERE room_id = ? AND created_at > ?").get(room, Date.now() - PEER_RATE.ms) as { n: number }).n;
    if (recent >= PEER_RATE.n) throw new HttpError(429, `${app.machineName()} is taking no more questions from ${caller.machine} for a while.`, "rate");
    const full = () => new HttpError(429, `${app.machineName()} is answering other questions right now. Try again in a moment.`, "busy");
    if (this.live.size >= limits.running) throw full();
    const { target, local } = await this.resolve({ provider: t.provider as ChatProvider, account: t.account as string, model: t.model ?? null, effort: t.effort ?? null });
    // The slot is taken in the same breath it's checked (the model list above took a moment).
    if (this.live.size >= limits.running || this.closing) throw full();
    if (gone.aborted) throw new HttpError(409, `${caller.machine} hung up before ${app.machineName()} could start.`, "gone");
    const id = newId("ask");
    // What can fail comes before the slot is taken, so a failure can't leave the slot taken.
    const scratch = scratchFolder();
    const now = Date.now();
    try {
      this.db.query("DELETE FROM asks WHERE room_id LIKE 'peer:%' AND ended_at IS NOT NULL AND ended_at < ?").run(now - 24 * 3_600_000);
      this.db
        .query("INSERT INTO asks (id, room_id, message_id, provider, account, model, effort, label, status, is_local, created_at, started_at) VALUES (?, ?, 'peer', ?, ?, ?, ?, ?, 'running', ?, ?, ?)")
        .run(id, room, target.provider, target.account, target.model, target.effort, `Asked from ${caller.machine}`, local ? 1 : 0, now, now);
    } catch (e) {
      scratch.done();
      throw e;
    }
    log.info(`${caller.machine} asked ${target.provider}${target.account === DEFAULT_ACCOUNT ? "" : ` (${target.account})`} a question of ${(prompt.length + systemNote.length).toLocaleString("en-US")} characters`);
    const abort = new AbortController();
    const entry = { abort, run: Promise.resolve() };
    this.live.set(id, entry);
    const hangUp = () => abort.abort();
    gone.addEventListener("abort", hangUp, { once: true });
    const asked: Room = { id: `r_${id}`, name: `Asked from ${caller.machine}`, cwd: scratch.dir, mode: "direct", leadMemberId: null, maxHops: 0, rounds: 1, parallel: false, createdAt: now, updatedAt: now, archived: false };
    const finished = (async (): Promise<PeerAnswer> => {
      try {
        const r = await runOneShot(app, { room: asked, provider: target.provider, account: target.account, model: target.model, effort: target.effort, prompt, systemNote: systemNote || null, signal: abort.signal, timeoutMs: limits.timeoutMs, graceMs: limits.graceMs, onDriver: (d) => this.drivers.set(id, d) });
        const answered = r.ok && !!r.text;
        const used = r.usage.inputTokens > 0 || r.usage.outputTokens > 0 || (r.usage.costUsd ?? 0) > 0;
        const cost = answered || used ? this.costOf(target, local, r.usage) : null;
        if (cost) {
          try {
            app.spend.record({ source: "ask", provider: target.provider, account: target.account, roomId: null, chatName: `Asked from ${caller.machine}`, askId: id, model: target.model, inputTokens: cost.inputTokens, outputTokens: cost.outputTokens, cachedTokens: r.usage.cachedInputTokens, costUsd: cost.costUsd, basis: cost.basis });
          } catch (e) {
            log.warn(`couldn't keep a linked machine's ask cost: ${e instanceof Error ? e.message : e}`);
          }
        }
        this.db
          .query("UPDATE asks SET status = ?, ended_at = ?, cost_usd = ?, basis = ?, in_tokens = ?, out_tokens = ? WHERE id = ? AND status = 'running'")
          .run(answered ? "done" : r.stopped ? "stopped" : "error", Date.now(), cost?.costUsd ?? null, cost?.basis ?? null, cost?.inputTokens ?? 0, cost?.outputTokens ?? 0, id);
        return { ok: r.ok, text: peerCut(r.text), error: r.error, stopped: r.stopped, timedOut: r.timedOut, usage: { ...r.usage, costUsd: cost?.costUsd ?? null, basis: cost?.basis ?? "unknown" } };
      } finally {
        gone.removeEventListener("abort", hangUp);
        scratch.done();
        this.live.delete(id);
        this.drivers.delete(id);
        // Whatever went wrong, the row doesn't stay "running" (the idle watcher would wait for it): a no-op once it was ended above.
        this.db.query("UPDATE asks SET status = 'error', ended_at = ? WHERE id = ? AND status = 'running'").run(Date.now(), id);
        this.pump();
      }
    })();
    entry.run = finished.then(
      () => undefined,
      () => undefined,
    );
    return finished;
  }
}

/** The linked machine a request here comes from (the sign-in it was made with belongs to that hub), never anyone else. */
interface PeerCaller {
  hubId: string;
  machine: string;
}

function linkedHub(app: App, device: Device): PeerCaller {
  const hub = app.machines.hubOfDevice(device);
  if (!hub) throw new HttpError(403, "Only a machine linked with this one can use this.", "not_linked");
  return { hubId: hub.id, machine: hub.name };
}

export function askRoutes(app: App): Route[] {
  return [
    route("GET", "/api/asks/targets", async ({ url }) => {
      // Apps from before 0.5 expect this machine's plain list (rows of other machines would collide with theirs); the 0.5
      // apps ask with machines=1 for every machine's rows and for the machines that couldn't answer.
      const machines = url.searchParams.get("machines") === "1";
      // Newer than 0.6.1: the sheet asks with models=1 for what each row can be asked on (the @ popup doesn't need them).
      const found = await app.asks.targetsFor(url.searchParams.get("room") ?? "", { refresh: url.searchParams.get("refresh") === "1", machines, models: url.searchParams.get("models") === "1" });
      return machines ? found : found.choices;
    }),
    route("GET", "/api/rooms/:id/asks", ({ params }) => {
      if (!app.store.getRoom(params.id)) throw new HttpError(404, "room not found");
      return app.asks.list(params.id);
    }),
    route("POST", "/api/asks", async ({ body }) => {
      const b = (await body()) ?? {};
      return app.asks.start({ roomId: b.roomId, messageId: b.messageId, targets: b.targets, note: b.note, remember: b.remember });
    }),
    route("POST", "/api/asks/:id/stop", ({ params }) => app.asks.stop(params.id)),
    route("DELETE", "/api/asks/:id", ({ params }) => app.asks.remove(params.id)),
    // For linked machines' hubs only (a person's own device is refused: it has the routes above). The order matters: who it is,
    // the switch, then the size (counted as the body arrives), only then anything that could spend money.
    peerRoute("GET", "/api/asks/peer-targets", ({ device, url }) => {
      linkedHub(app, device);
      // Newer than 0.6.1: with models=1, what each row can be asked on, so the asking machine's sheet can pick one.
      return app.asks.peerTargets({ models: url.searchParams.get("models") === "1" });
    }),
    peerRoute("POST", "/api/asks/peer", async ({ req, device }) => {
      const caller = linkedHub(app, device);
      app.asks.peerGate();
      let body: unknown;
      try {
        body = JSON.parse((await readCapped(req, PEER_BODY)) || "{}");
      } catch (e) {
        throw e instanceof HttpError ? e : new HttpError(400, "That isn't a question Crosstalk can read.");
      }
      return app.asks.peerAsk(caller, body, req.signal);
    }),
  ];
}
