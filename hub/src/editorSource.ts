// The image editor's phone page, kept in this repository (editor/phone_editor) and put into the user's install.
//
// The page is a ComfyUI custom node: `editor.html` is read for every request (__init__.py serves it with
// Cache-Control: no-store), so replacing that file is picked up on the next page load and needs no restart.
// `__init__.py` is only read when ComfyUI imports its custom nodes, so a change there waits for the server's
// next start — which is why `editorFiles` marks it, nothing here ever starts or stops a server, and the page's
// own design needs no new route.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import EDITOR_PAGE from "../../editor/phone_editor/editor.html" with { type: "text" };
import EDITOR_INIT from "../../editor/phone_editor/__init__.py" with { type: "text" };

// Bun's own types call any .html import an HTMLBundle, so its type is put right here: `with { type: "text" }`
// makes it the file's text, in the compiled binary as well (checked against both). The .py one is typed by
// src/text-modules.d.ts.
const EDITOR_HTML = EDITOR_PAGE as unknown as string;

/** Where the page lives inside an install, under the editor's own folder. */
export const EDITOR_NODE = join("ComfyUI", "custom_nodes", "phone_editor");

export interface EditorFile {
  name: string;
  text: string;
  /** True when ComfyUI only reads it at start-up, so a change waits for the next one. */
  waits: boolean;
}

/** The page as this repository holds it. */
export function editorFiles(): EditorFile[] {
  return [
    { name: "editor.html", text: EDITOR_HTML, waits: false },
    { name: "__init__.py", text: EDITOR_INIT, waits: true },
  ];
}

export interface EditorSync {
  /** The files written, in the order of `editorFiles`. */
  changed: string[];
  /** Of those, the ones that only take effect when ComfyUI next starts. */
  waiting: string[];
  /** Why nothing could be done: no install there, or a file that couldn't be read or written. */
  problem: string | null;
}

const nodeDir = (dir: string) => join(dir, EDITOR_NODE);

/** What a file in the install says now, or null when it isn't there or can't be read. */
function installed(dir: string, name: string): string | null {
  try {
    return readFileSync(join(nodeDir(dir), name), "utf8");
  } catch {
    return null;
  }
}

/**
 * Which of the page's files differ from this repository's. An install that isn't there is a problem, not an
 * empty answer, so the caller can say so rather than silently doing nothing.
 */
export function editorDiff(dir: string): { changed: string[]; waiting: string[]; problem: string | null } {
  if (!existsSync(join(dir, "ComfyUI"))) return { changed: [], waiting: [], problem: `there's no ComfyUI in ${dir}` };
  const files = editorFiles().filter((f) => installed(dir, f.name) !== f.text);
  return { changed: files.map((f) => f.name), waiting: files.filter((f) => f.waits).map((f) => f.name), problem: null };
}

/**
 * Puts this repository's page into an install, writing only the files that differ. Nothing is started, stopped
 * or signalled: a running server keeps running, and serves the new page the next time a device loads it.
 *
 * What it replaced is kept beside it as `<name>.replaced`, so a page edited by hand on the machine isn't lost.
 * Each file is written next to its place and moved over it, so a page load can never read half a file.
 */
export function syncEditor(dir: string): EditorSync {
  const diff = editorDiff(dir);
  if (diff.problem) return { changed: [], waiting: [], problem: diff.problem };
  const target = nodeDir(dir);
  const changed: string[] = [];
  const waiting: string[] = [];
  for (const file of editorFiles()) {
    const was = installed(dir, file.name);
    if (was === file.text) continue;
    try {
      mkdirSync(target, { recursive: true });
      if (was !== null) writeFileSync(join(target, `${file.name}.replaced`), was);
      const tmp = join(target, `.${file.name}.new`);
      writeFileSync(tmp, file.text);
      renameSync(tmp, join(target, file.name));
    } catch (e) {
      return { changed, waiting, problem: `couldn't write ${file.name}: ${e instanceof Error ? e.message : String(e)}` };
    }
    changed.push(file.name);
    if (file.waits) waiting.push(file.name);
  }
  return { changed, waiting, problem: null };
}

/** What to say about a sync, in plain words, or null when there was nothing to do. */
export function syncWords(done: EditorSync): string | null {
  if (done.problem) return `the editor page wasn't put in place: ${done.problem}`;
  if (!done.changed.length) return null;
  const now = done.changed.filter((n) => !done.waiting.includes(n));
  const parts: string[] = [];
  if (now.length) parts.push(`${now.join(", ")} updated; devices get it the next time they open the page`);
  if (done.waiting.length) parts.push(`${done.waiting.join(", ")} updated; it starts working when ComfyUI next starts`);
  return parts.join(" · ");
}
