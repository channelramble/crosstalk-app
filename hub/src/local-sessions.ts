// Conversations that live in the agents' own apps on this machine: Claude Code sessions (the desktop app's and the
// terminal's, which share one transcript store) and Codex threads (shared by the Codex app, CLI and IDE extension).
// Chats in this app can continue them, and can bring in what was said there.

import { constants, copyFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { LocalSession } from "@crosstalk/shared";
import { logger } from "./util/log";

const log = logger("local-sessions");

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** How Crosstalk's old group rooms opened every agent session: agents' internals, not conversations to continue. */
const GROUP_ROOM_BRIEFING = /^(\(?[^)]*\)\s*)?You are @[\w-]+, one of several AI coding agents/;

export function isGroupRoomSession(firstPrompt: string | null | undefined): boolean {
  return !!firstPrompt && GROUP_ROOM_BRIEFING.test(firstPrompt.trim());
}

// ===================================================================== Claude Code

/** Where Claude Code keeps its transcripts (the main sign-in; extra accounts keep their own elsewhere). */
export function claudeProjectsDir(configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")): string {
  return join(configDir, "projects");
}

/**
 * The folder in the projects directory that holds a project's sessions, named the way Claude Code names it: every
 * character but letters and digits becomes "-", and a long name is cut and ends with a hash of the whole path.
 */
export function claudeProjectDirName(cwd: string): string {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= 200) return name;
  let h = 0;
  for (let i = 0; i < cwd.length; i++) h = ((h << 5) - h + cwd.charCodeAt(i)) | 0;
  return `${name.slice(0, 200)}-${Math.abs(h).toString(36)}`;
}

/** The Claude desktop app's own list of its Code sessions (title, folder, archived), by Claude Code session id. */
function claudeAppIndex(): Map<string, { title: string; cwd: string | null; updatedAt: number; archived: boolean }> {
  const out = new Map<string, { title: string; cwd: string | null; updatedAt: number; archived: boolean }>();
  const root = join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions");
  if (!existsSync(root)) return out;
  const walk = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(dir, name);
      if (name.startsWith("local_") && name.endsWith(".json")) {
        try {
          const s = JSON.parse(readFileSync(p, "utf8"));
          if (s?.cliSessionId) out.set(String(s.cliSessionId), { title: String(s.title ?? ""), cwd: s.cwd ?? null, updatedAt: Number(s.lastActivityAt ?? s.createdAt ?? 0), archived: !!s.isArchived });
        } catch {
          // a file being written right now: skip it this time
        }
      } else if (depth < 3) {
        try {
          if (statSync(p).isDirectory()) walk(p, depth + 1);
        } catch {
          // gone meanwhile
        }
      }
    }
  };
  walk(root, 0);
  return out;
}

/** What a transcript's first few lines say about it. Cached per file version. */
interface TranscriptHead {
  cwd: string | null;
  firstPrompt: string | null;
  customTitle: string | null;
}
const headCache = new Map<string, { mtime: number; size: number; head: TranscriptHead }>();

/** Text a person typed, from a transcript `user` entry; null for tool results, slash commands and meta entries. */
export function claudeUserText(e: Json): string | null {
  if (e?.type !== "user" || e.isMeta || e.isSidechain || e.isCompactSummary) return null;
  const c = e.message?.content;
  const parts: string[] = typeof c === "string" ? [c] : Array.isArray(c) ? c.filter((b: Json) => b?.type === "text").map((b: Json) => String(b.text ?? "")) : [];
  // Harness notes ride along with what the person typed: keep only the typed part.
  const t = parts.map((p) => p.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim()).filter(Boolean).join("\n");
  if (!t) return null;
  // Slash commands, their local output and harness notes aren't something the person said.
  if (/^<(command-|local-command|system-reminder|bash-|user-memory|task-notification)/.test(t)) return null;
  if (t.startsWith("Caveat: The messages below were generated")) return null;
  return t;
}

/** The text a Claude reply showed, from a transcript `assistant` entry (tool calls and thinking left out). */
export function claudeAssistantText(e: Json): string {
  if (e?.type !== "assistant" || e.isSidechain || e.isApiErrorMessage) return "";
  const c = e.message?.content;
  if (!Array.isArray(c)) return "";
  return c.filter((b: Json) => b?.type === "text" && b.text).map((b: Json) => b.text).join("\n\n").trim();
}

function readHead(path: string, bytes = 96 * 1024): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function transcriptHead(path: string, mtime: number, size: number): TranscriptHead {
  const hit = headCache.get(path);
  if (hit && hit.mtime === mtime && hit.size === size) return hit.head;
  const head: TranscriptHead = { cwd: null, firstPrompt: null, customTitle: null };
  try {
    const lines = readHead(path).split("\n");
    lines.pop(); // the last one may be cut off
    for (const line of lines) {
      let e: Json;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (!head.cwd && typeof e.cwd === "string") head.cwd = e.cwd;
      if (e.type === "custom-title" && e.customTitle) head.customTitle = String(e.customTitle);
      if (e.type === "summary" && e.summary && !head.customTitle) head.customTitle = String(e.summary);
      if (!head.firstPrompt) head.firstPrompt = claudeUserText(e);
      if (head.cwd && head.firstPrompt && head.customTitle) break;
    }
  } catch (e) {
    log.debug(`couldn't read ${path}: ${e}`);
  }
  headCache.set(path, { mtime, size, head });
  return head;
}

/** Claude Code session ids open in some other process right now (the desktop app keeps one per open session). */
export function claudeSessionsInUse(): Set<string> {
  const out = new Set<string>();
  try {
    const ps = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="], { stdout: "pipe", stderr: "ignore" });
    for (const line of ps.stdout.toString().split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m || Number(m[2]) === process.pid || !/\bclaude\b/.test(m[3])) continue; // our own agents don't count
      for (const r of m[3].matchAll(/--(?:resume|session-id)[= ]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g)) out.add(r[1]);
    }
  } catch (e) {
    log.debug(`ps failed: ${e}`);
  }
  return out;
}

/** Path of a Claude Code session's transcript, or null if it isn't on this machine. */
export function claudeTranscriptPath(sessionId: string, projectsDir = claudeProjectsDir()): string | null {
  if (!/^[0-9a-f-]{36}$/.test(sessionId) || !existsSync(projectsDir)) return null;
  const found: string[] = [];
  for (const dir of readdirSync(projectsDir)) {
    const p = join(projectsDir, dir, `${sessionId}.jsonl`);
    if (existsSync(p)) found.push(p);
  }
  if (found.length < 2) return found[0] ?? null;
  // A chat duplicated into another folder copies the transcript there until its first reply forks it
  // (copyClaudeTranscript): the session's own is the one in the folder it was written in.
  return found.find((p) => inOwnFolder(p)) ?? found[0];
}

/**
 * Whether a transcript is in its own project's folder (true), or is a copy made for a duplicated chat in another
 * project's folder (false, see copyClaudeTranscript); null when it doesn't say where it was written.
 */
function inOwnFolder(path: string): boolean | null {
  try {
    const st = statSync(path);
    const cwd = transcriptHead(path, st.mtimeMs, st.size).cwd;
    return cwd ? basename(dirname(path)) === claudeProjectDirName(cwd) : null;
  } catch {
    return null;
  }
}

/** A transcript copied into another project's folder for a duplicated chat (copyClaudeTranscript), not an original. */
export function isClaudeTranscriptCopy(path: string): boolean {
  return inOwnFolder(path) === false;
}

/**
 * Where a fork of a transcript ends (--resume-session-at): the last of the assistant's messages on the conversation's
 * current path, before `before` (one of the user's messages, by its uuid) when that's given, so a request that was
 * stopped or never answered stays out of the fork. Claude Code finds only messages on that path, so it's never a step
 * it doesn't load as a message, nor one a rewind left behind. Null when there's none in the transcript's newest 16 MB,
 * or it can't be read (the fork then takes the whole conversation).
 */
export function claudeForkPoint(path: string, before: string | null = null): string | null {
  let text: string;
  try {
    const size = statSync(path).size;
    const bytes = Math.min(size, 16 * 1024 * 1024);
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(bytes);
      const n = readSync(fd, buf, 0, bytes, size - bytes);
      text = buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  const entries = new Map<string, { type: unknown; parent: string | null }>();
  let last: string | null = null;
  for (const line of text.split("\n")) {
    let e: Json;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // cut off (the first line read, or one still being written)
    }
    if (typeof e?.uuid !== "string" || !("parentUuid" in e) || e.isSidechain) continue;
    entries.set(e.uuid, { type: e.type, parent: typeof e.parentUuid === "string" ? e.parentUuid : null });
    last = e.uuid;
  }
  // The conversation's path runs back from its newest entry (or from just before that message, when it's there).
  let at = before && entries.has(before) ? entries.get(before)!.parent : last;
  for (let steps = 0; at && steps < 1_000_000; steps++) {
    const e = entries.get(at);
    if (!e) return null;
    if (e.type === "assistant") return at;
    at = e.parent;
  }
  return null;
}

/** A transcript copy made for a duplicated chat, as it was made: it's deleted later only if nothing changed it since. */
export interface TranscriptCopy {
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * Copies a session's transcript into another folder's project directory, so Claude Code started in that folder finds
 * it (and forks it) on --resume: one copy per name the folder goes by (its path and, if that differs, the real path
 * Claude Code reports). Returns the copies it made, to delete once the fork exists; none when the transcript is
 * already in that folder's directory. A file already there is left as it is, and never counted as a copy.
 */
export function copyClaudeTranscript(path: string, cwd: string, projectsDir = claudeProjectsDir()): TranscriptCopy[] {
  const names = new Set([claudeProjectDirName(resolve(cwd))]);
  try {
    names.add(claudeProjectDirName(realpathSync(cwd)));
  } catch {
    // not made yet: its path is its name
  }
  if (names.has(basename(dirname(path)))) return [];
  const out: TranscriptCopy[] = [];
  for (const name of names) {
    const dir = join(projectsDir, name);
    const to = join(dir, basename(path));
    if (existsSync(to)) continue;
    mkdirSync(dir, { recursive: true });
    copyFileSync(path, to, constants.COPYFILE_EXCL);
    const st = statSync(to);
    out.push({ path: to, size: st.size, mtimeMs: st.mtimeMs });
  }
  return out;
}

/** Whether a transcript copy is still exactly as it was made (nobody went on with the conversation in it). */
export function unchangedCopy(copy: TranscriptCopy): boolean {
  try {
    const st = statSync(copy.path);
    return st.isFile() && st.size === copy.size && st.mtimeMs === copy.mtimeMs;
  } catch {
    return false;
  }
}

/**
 * A copy noted before copies kept how they were made (just its path): unchanged when it's a copy (it names another
 * project's folder) whose every byte is still the start of the original, so nothing was added to it.
 */
export function legacyCopyUnchanged(path: string): boolean {
  if (!isClaudeTranscriptCopy(path)) return false;
  const original = claudeTranscriptPath(basename(path, ".jsonl"), dirname(dirname(path)));
  if (!original || original === path) return false;
  try {
    const copy = readFileSync(path);
    const from = readFileSync(original);
    return copy.length <= from.length && copy.equals(from.subarray(0, copy.length));
  } catch {
    return false;
  }
}

/**
 * Claude Code sessions on this machine, newest first. Leaves out sessions with nothing anyone typed (Crosstalk's old
 * usage checks), and ones in `exclude` (sessions of old multi-agent rooms).
 */
export function listClaudeSessions(opts: { limit?: number; exclude?: Set<string>; linked?: Map<string, string>; projectsDir?: string } = {}): LocalSession[] {
  const dir = opts.projectsDir ?? claudeProjectsDir();
  if (!existsSync(dir)) return [];
  const files: { id: string; path: string; mtime: number; size: number }[] = [];
  for (const project of readdirSync(dir)) {
    const pdir = join(dir, project);
    let names: string[];
    try {
      names = readdirSync(pdir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -6);
      if (opts.exclude?.has(id)) continue;
      try {
        const st = statSync(join(pdir, name));
        files.push({ id, path: join(pdir, name), mtime: st.mtimeMs, size: st.size });
      } catch {
        // removed meanwhile
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  // A duplicated chat's copy of a transcript (copyClaudeTranscript) has the original's id: the session is listed once,
  // from its own folder.
  const count = new Map<string, number>();
  for (const f of files) count.set(f.id, (count.get(f.id) ?? 0) + 1);
  const kept = new Map<string, (typeof files)[number]>();
  for (const f of files) {
    if (count.get(f.id)! < 2) continue;
    const cur = kept.get(f.id);
    if (!cur || (!inOwnFolder(cur.path) && inOwnFolder(f.path))) kept.set(f.id, f);
  }
  const unique = kept.size ? files.filter((f) => count.get(f.id)! < 2 || kept.get(f.id) === f) : files;
  const app = claudeAppIndex();
  const inUse = claudeSessionsInUse();
  const out: LocalSession[] = [];
  const limit = opts.limit ?? 60;
  for (const f of unique) {
    if (out.length >= limit) break;
    const fromApp = app.get(f.id);
    if (fromApp?.archived) continue;
    const head = transcriptHead(f.path, f.mtime, f.size);
    if (!head.firstPrompt && !fromApp) continue; // nothing anyone said: an automatic check, not a conversation
    if (!fromApp && isGroupRoomSession(head.firstPrompt)) continue;
    out.push({
      provider: "claude",
      id: f.id,
      title: oneLine(fromApp?.title || head.customTitle || head.firstPrompt || "Untitled session"),
      cwd: fromApp?.cwd ?? head.cwd,
      updatedAt: Math.max(f.mtime, fromApp?.updatedAt ?? 0),
      source: fromApp ? "claude-app" : "claude-cli",
      busy: inUse.has(f.id),
      chatId: opts.linked?.get(f.id) ?? null,
    });
  }
  return out;
}

export interface ImportedMessage {
  role: "user" | "assistant";
  text: string;
  at: number;
}

/**
 * The conversation in a Claude Code transcript from byte `offset` on, as alternating user and assistant messages
 * (each reply's text joined; tool calls and thinking left out). Lines starting inside one of the `skip` byte ranges
 * are left out (what a chat's own replies wrote). Also returns where the transcript ends, to read on from next time.
 */
export function readClaudeTranscript(path: string, offset = 0, skip: [number, number][] = []): { messages: ImportedMessage[]; end: number } {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { messages: [], end: offset };
  }
  if (size <= offset) return { messages: [], end: size };
  const fd = openSync(path, "r");
  let text: string;
  try {
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    text = buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
  // Only whole lines: a line still being written is read next time.
  const lastNl = text.lastIndexOf("\n");
  if (lastNl < 0) return { messages: [], end: offset };
  const end = offset + Buffer.byteLength(text.slice(0, lastNl + 1), "utf8");
  const messages: ImportedMessage[] = [];
  let pos = offset;
  for (const line of text.slice(0, lastNl).split("\n")) {
    const start = pos;
    pos += Buffer.byteLength(line, "utf8") + 1;
    if (skip.some(([from, to]) => start >= from && start < to)) continue;
    let e: Json;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(e.timestamp ?? "") || Date.now();
    const user = claudeUserText(e);
    if (user) {
      messages.push({ role: "user", text: user, at });
      continue;
    }
    const reply = claudeAssistantText(e);
    if (!reply) continue;
    const last = messages[messages.length - 1];
    if (last?.role === "assistant") last.text = `${last.text}\n\n${reply}`;
    else messages.push({ role: "assistant", text: reply, at });
  }
  return { messages, end };
}

// ===================================================================== Codex

/** Codex threads as `thread/list` returns them → local sessions. Subagent and throwaway threads are left out. */
export function codexThreadsToSessions(threads: Json[], opts: { exclude?: Set<string>; linked?: Map<string, string> } = {}): LocalSession[] {
  return (Array.isArray(threads) ? threads : [])
    .filter((t) => t?.id && !t.parentThreadId && !t.ephemeral && !opts.exclude?.has(t.id) && !isGroupRoomSession(t.preview))
    .map((t) => ({
      provider: "codex" as const,
      id: String(t.id),
      title: oneLine(String(t.name || t.preview || "Untitled thread")),
      cwd: t.cwd ?? null,
      updatedAt: Number(t.updatedAt ?? t.createdAt ?? 0) * 1000,
      source: "codex-app" as const,
      busy: t.status?.type === "active",
      chatId: opts.linked?.get(String(t.id)) ?? null,
    }));
}

/** A Codex thread's conversation (`thread/read` with turns) as user and assistant messages, with each turn's id. */
export function codexThreadMessages(thread: Json): (ImportedMessage & { turnId: string })[] {
  const out: (ImportedMessage & { turnId: string })[] = [];
  for (const turn of thread?.turns ?? []) {
    const at = Number(turn.startedAt ?? 0) * 1000 || Date.now();
    let reply = "";
    for (const item of turn.items ?? []) {
      if (item.type === "userMessage") {
        const text = (item.content ?? []).filter((c: Json) => c?.type === "text").map((c: Json) => c.text).join("\n").trim();
        if (text) out.push({ role: "user", text, at, turnId: String(turn.id) });
      } else if (item.type === "agentMessage" && item.text) {
        reply = reply ? `${reply}\n\n${item.text}` : item.text;
      }
    }
    if (reply.trim()) out.push({ role: "assistant", text: reply.trim(), at: Number(turn.completedAt ?? turn.startedAt ?? 0) * 1000 || at, turnId: String(turn.id) });
  }
  return out;
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 120 ? `${t.slice(0, 117)}…` : t;
}
