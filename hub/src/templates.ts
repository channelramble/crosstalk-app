// Prompt templates (Settings → Templates; New chat → From a template): ways to start a chat, kept by each machine's hub in the
// person's order. A template has a name and the chat's first message, whose "{blanks}" the app asks for when a chat starts from
// it (web/src/templates.ts), and optionally the agent, account, model, effort and folder. Every change goes to every device as a
// `templates` event with the whole list (a few dozen at most), and every change's answer is that list too. A new hub, or one
// updated to this, gets three starters once: deleted, they stay deleted unless Settings adds them back.

import type { Database } from "bun:sqlite";
import { CHAT_PROVIDERS, DEFAULT_ACCOUNT, TEMPLATES_MAX, TEMPLATE_NAME_MAX, TEMPLATE_STARTERS, TEMPLATE_TEXT_MAX, type ChatProvider, type PromptTemplate, type TemplateInput } from "@crosstalk/shared";
import type { App } from "./app";
import { HttpError } from "./engine/engine";
import { route, type Route } from "./routes";
import { newId } from "./util/ids";

const SCHEMA = `CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  agent TEXT,
  account TEXT,
  model TEXT,
  effort TEXT,
  folder TEXT,
  text TEXT NOT NULL,
  position INTEGER NOT NULL,
  starter TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

/** kv: this database has had its starters (once: the ones the person deletes aren't added again by themselves). */
const SEEDED = "templates.starters";

type Starter = { key: (typeof TEMPLATE_STARTERS)[number]; name: string; text: string };

/** What Crosstalk starts with: plain asks that work with either agent, in any folder. */
export const STARTERS: readonly Starter[] = [
  {
    key: "bug",
    name: "Fix a bug",
    text: "Something isn't working: {what goes wrong}. It should {what should happen}. Find the cause, fix it, and tell me how you checked that the fix works.",
  },
  {
    key: "plan",
    name: "Plan it first",
    text: "I want to {what you want to build or change}. Before you change anything, ask me what you need to know, then write a short plan. Wait for my go-ahead before you start.",
  },
  {
    key: "review",
    name: "Review my changes",
    text: "Review the changes in this folder that aren't committed yet. List bugs and risky parts first, then smaller things. Don't change any files.",
  },
];

/** Never the bare "not found" of a route a hub doesn't have: the app takes that for a hub from before templates. */
const GONE = "That template is gone. It may have been deleted on another device.";
const FOLDER_MAX = 1_000;

interface Row {
  id: string;
  name: string;
  agent: string | null;
  account: string | null;
  model: string | null;
  effort: string | null;
  folder: string | null;
  text: string;
  position: number;
  starter: string | null;
  created_at: number;
  updated_at: number;
}

const toTemplate = (r: Row): PromptTemplate => ({
  id: r.id,
  name: r.name,
  // An agent this hub no longer has counts as none: New chat's own.
  agent: (CHAT_PROVIDERS as readonly string[]).includes(r.agent ?? "") ? (r.agent as ChatProvider) : null,
  account: r.account,
  model: r.model,
  effort: r.effort,
  folder: r.folder,
  text: r.text,
  ...(r.starter ? { starter: r.starter } : {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** The fields of a template that can be set, as the table keeps them. */
type Fields = Pick<PromptTemplate, "name" | "agent" | "account" | "model" | "effort" | "folder" | "text">;

/** Makes the table (an additive migration: older databases have none) and adds the starters the first time. */
export function ensureTemplates(db: Database, kv: { get(key: string): string | null; set(key: string, value: string): void }) {
  db.exec(SCHEMA);
  if (kv.get(SEEDED)) return;
  db.transaction(() => {
    insertStarters(db, STARTERS);
    kv.set(SEEDED, "1");
  })();
}

/** Adds `starters` after what's there. */
function insertStarters(db: Database, starters: readonly Starter[]) {
  const last = (db.query("SELECT MAX(position) AS p FROM templates").get() as { p: number | null }).p ?? -1;
  const now = Date.now();
  starters.forEach((s, i) => {
    db.query("INSERT INTO templates (id, name, agent, account, model, effort, folder, text, position, starter, created_at, updated_at) VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)").run(newId("tp"), s.name, s.text, last + 1 + i, s.key, now, now);
  });
}

const text = (v: unknown, what: string): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new HttpError(400, `The ${what} must be text.`);
  return v;
};

/** One line, trimmed, at most `max` characters; null when nothing is left. */
const oneLine = (v: unknown, what: string, max: number): string | null => text(v, what)?.replace(/\s+/g, " ").trim().slice(0, max) || null;

/**
 * What a request may set, checked: each field it gives (on a change, `current`, the ones it leaves out stay), refused in plain
 * words when it can't be kept. An agent's account must be on this machine; account, model and effort only go with an agent.
 */
function checked(app: App, input: unknown, current: Fields | null): Fields {
  const b = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const has = (k: keyof TemplateInput) => Object.hasOwn(b, k);
  const next: Fields = current ? { ...current } : { name: "", agent: null, account: null, model: null, effort: null, folder: null, text: "" };
  if (has("name") || !current) {
    next.name = oneLine(b.name, "name", TEMPLATE_NAME_MAX) ?? "";
    if (!next.name) throw new HttpError(400, "Give the template a name.");
  }
  if (has("text") || !current) {
    // Its own lines stay: only the ends are trimmed.
    const t = text(b.text, "first message")?.replace(/\r\n?/g, "\n").trim() ?? "";
    if (!t) throw new HttpError(400, "Write the first message the chat starts with.");
    if (t.length > TEMPLATE_TEXT_MAX) throw new HttpError(400, `The first message is too long: ${TEMPLATE_TEXT_MAX.toLocaleString("en-US")} characters at most.`);
    next.text = t;
  }
  if (has("agent")) {
    const agent = b.agent === "" ? null : b.agent ?? null;
    if (agent !== null && !(CHAT_PROVIDERS as readonly unknown[]).includes(agent)) throw new HttpError(400, "Templates start chats with Claude Code or Codex.");
    // Another agent: what was picked for the one before doesn't carry over.
    if (agent !== next.agent) Object.assign(next, { account: null, model: null, effort: null });
    next.agent = agent as ChatProvider | null;
  }
  if (has("account")) {
    const account = oneLine(b.account, "account", 100);
    next.account = account === DEFAULT_ACCOUNT ? null : account;
  }
  if (has("model")) next.model = oneLine(b.model, "model", 200);
  if (has("effort")) next.effort = oneLine(b.effort, "effort", 40);
  if (!next.agent) Object.assign(next, { account: null, model: null, effort: null });
  // Only an account being picked is checked (a new template's, or another agent or account than it had): one whose account
  // was since removed can still be renamed, moved, or saved from the editor, which sends the account it has as it is.
  const picked = !current || next.agent !== current.agent || next.account !== current.account;
  if (next.agent && next.account && picked && !app.providers.hasAccount(next.agent, next.account)) {
    throw new HttpError(400, "That account isn't on this machine. Pick another one.");
  }
  if (has("folder")) {
    const folder = text(b.folder, "folder")?.trim() || null;
    // "~/…", not a bare "~": a chat's folder is only read as the home folder's from "~/" on (chats.ts).
    if (folder && !/^(\/|~\/)/.test(folder)) throw new HttpError(400, "The folder must be a full path, like /Users/you/Projects/app.");
    if (folder && folder.length > FOLDER_MAX) throw new HttpError(400, "That folder's path is too long.");
    if (folder?.includes("\0")) throw new HttpError(400, "That folder's path has a character no folder can have.");
    next.folder = folder;
  }
  return next;
}

/** A move's place in the list: a whole number from 0 (the top). */
function place(body: unknown): number {
  const to = body && typeof body === "object" ? (body as { to?: unknown }).to : undefined;
  if (typeof to !== "number" || !Number.isInteger(to)) throw new HttpError(400, "Say where to move the template (to: its place, 0 for the top).");
  return to;
}

/** This machine's templates (App.templates). */
export class Templates {
  constructor(private app: App) {
    ensureTemplates(app.store.db, { get: (k) => app.store.kvGet(k), set: (k, v) => app.store.kvSet(k, v) });
  }

  private get db() {
    return this.app.store.db;
  }

  /** In the person's order. */
  list(): PromptTemplate[] {
    return (this.db.query("SELECT * FROM templates ORDER BY position, created_at").all() as Row[]).map(toTemplate);
  }

  private row(id: string): Row {
    const r = this.db.query("SELECT * FROM templates WHERE id = ?").get(id) as Row | null;
    if (!r) throw new HttpError(404, GONE, "no_template");
    return r;
  }

  /** Numbers them 0, 1, 2… in `ids`' order. */
  private renumber(ids: string[]) {
    const set = this.db.query("UPDATE templates SET position = ? WHERE id = ?");
    ids.forEach((id, i) => set.run(i, id));
  }

  /** Every device hears the list as it is now; the change's answer is the same list. */
  private changed(): PromptTemplate[] {
    const templates = this.list();
    this.app.bus.emit({ t: "templates", templates });
    return templates;
  }

  /** A new template goes first: it's the one being looked for next. */
  create(input: unknown): PromptTemplate[] {
    if (this.list().length >= TEMPLATES_MAX) throw new HttpError(409, `This machine keeps up to ${TEMPLATES_MAX} templates. Delete one, then add this again.`, "full");
    const f = checked(this.app, input, null);
    const id = newId("tp");
    const now = Date.now();
    this.db.transaction(() => {
      const ids = this.list().map((t) => t.id);
      this.db.query("INSERT INTO templates (id, name, agent, account, model, effort, folder, text, position, starter, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)").run(id, f.name, f.agent, f.account, f.model, f.effort, f.folder, f.text, now, now);
      this.renumber([id, ...ids]);
    })();
    return this.changed();
  }

  /** Changes what `input` gives (a rename gives only the name). */
  update(id: string, input: unknown): PromptTemplate[] {
    const r = this.row(id);
    const f = checked(this.app, input, toTemplate(r));
    // Updated even when the same is saved again: it was looked at and kept.
    this.db
      .query("UPDATE templates SET name = ?, agent = ?, account = ?, model = ?, effort = ?, folder = ?, text = ?, updated_at = ? WHERE id = ?")
      .run(f.name, f.agent, f.account, f.model, f.effort, f.folder, f.text, Math.max(Date.now(), r.updated_at + 1), id);
    return this.changed();
  }

  remove(id: string): PromptTemplate[] {
    this.row(id);
    this.db.transaction(() => {
      this.db.query("DELETE FROM templates WHERE id = ?").run(id);
      this.renumber(this.list().map((t) => t.id));
    })();
    return this.changed();
  }

  /** Moves it to place `to` (0 is the top; beyond the end is the end). */
  move(id: string, body: unknown): PromptTemplate[] {
    this.row(id);
    const to = place(body);
    this.db.transaction(() => {
      const ids = this.list().map((t) => t.id).filter((x) => x !== id);
      ids.splice(Math.max(0, Math.min(ids.length, to)), 0, id);
      this.renumber(ids);
    })();
    return this.changed();
  }

  /** The starters the person deleted, back at the end of the list (those still there aren't added twice). */
  restoreStarters(): PromptTemplate[] {
    const have = new Set(this.list().map((t) => t.starter));
    const missing = STARTERS.filter((s) => !have.has(s.key));
    if (!missing.length) return this.list();
    if (this.list().length + missing.length > TEMPLATES_MAX) throw new HttpError(409, `This machine keeps up to ${TEMPLATES_MAX} templates. Delete ${missing.length === 1 ? "one" : missing.length}, then add the starters again.`, "full");
    this.db.transaction(() => insertStarters(this.db, missing))();
    return this.changed();
  }
}

/** For people's devices only (`route`): templates aren't anything another machine's agents need. */
export function templateRoutes(app: App): Route[] {
  const body = (ctx: { body: () => Promise<unknown> }) => ctx.body().catch(() => ({}));
  return [
    route("GET", "/api/templates", () => app.templates.list()),
    route("POST", "/api/templates", async (ctx) => app.templates.create(await body(ctx))),
    route("POST", "/api/templates/starters", () => app.templates.restoreStarters()),
    route("PATCH", "/api/templates/:id", async (ctx) => app.templates.update(ctx.params.id, await body(ctx))),
    route("DELETE", "/api/templates/:id", ({ params }) => app.templates.remove(params.id)),
    route("POST", "/api/templates/:id/move", async (ctx) => app.templates.move(ctx.params.id, await body(ctx))),
  ];
}
