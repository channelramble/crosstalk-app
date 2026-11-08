/** Folder attachments: collect a dropped or picked folder's files with their paths inside it. */
import type { Upload } from "@crosstalk/shared";

export type FolderFile = { file: File; rel: string };
/** A file to upload, with its preview while it's a picture, and the hub's answer once it's up. */
export type PendingFile = { id: string; file: File; preview?: string; upload?: Upload };
/** A folder to upload: its files, or a .zip of it that the hub unpacks (how phones attach folders). */
export type PendingFolder = { id: string; name: string; files: FolderFile[]; bytes: number; skipped: string[]; zip?: File; token?: string; sent: number };


/** A v4 UUID. `crypto.randomUUID` only exists on HTTPS pages; `getRandomValues` works on plain HTTP too. */
export function uuid(): string {
  if (typeof crypto.randomUUID === "function" && globalThis.isSecureContext) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
// Only things that are never project content: dependency installs and git internals (agents can reinstall or
// re-clone them; they'd add thousands of files) and OS junk. Everything else, including build/ and dist/, is kept.
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const JUNK_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/** Groups files by their top folder. Reports exactly what was left out, so nothing goes missing silently. */
export function toFolders(files: FolderFile[], truncated: ReadonlySet<string> = new Set()): { folders: PendingFolder[]; errors: string[] } {
  const groups = new Map<string, { files: FolderFile[]; bytes: number; skipped: Set<string> }>();
  for (const f of files) {
    const parts = f.rel.split("/").filter(Boolean);
    if (parts.length < 2) continue;
    const g = groups.get(parts[0]) ?? { files: [], bytes: 0, skipped: new Set<string>() };
    groups.set(parts[0], g);
    const skipDir = parts.slice(1, -1).find((p) => SKIP_DIRS.has(p));
    if (skipDir) { g.skipped.add(`${skipDir}/`); continue; }
    if (JUNK_FILES.has(parts[parts.length - 1])) continue;
    g.files.push({ file: f.file, rel: parts.join("/") });
    g.bytes += f.file.size;
  }
  const folders: PendingFolder[] = [];
  const errors: string[] = [];
  for (const name of truncated) if (!groups.has(name)) errors.push(`${name}/ couldn't be read completely, so it wasn't attached. Try again.`);
  for (const [name, g] of groups) {
    if (!g.files.length) errors.push(`${name}/ has no files to attach.`);
    else if (truncated.has(name)) errors.push(`${name}/ couldn't be read completely, so it wasn't attached. Try again.`);
    else folders.push({ id: uuid(), name, files: g.files, bytes: g.bytes, skipped: [...g.skipped], sent: 0 });
  }
  return { folders, errors };
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Files from a folder picker (`webkitdirectory`), which carry `webkitRelativePath`. */
export function pickedFolderFiles(list: FileList | null): FolderFile[] {
  return Array.from(list ?? []).map((file) => ({ file, rel: file.webkitRelativePath || file.name }));
}

export type Dropped = { files: File[]; folderFiles: FolderFile[]; truncated: Set<string> };

/** Walks dropped folders. Returns plain dropped files separately so they attach as usual. */
export async function droppedItems(dt: DataTransfer): Promise<Dropped> {
  const entries = Array.from(dt.items)
    .map((i) => (i.kind === "file" ? i.webkitGetAsEntry?.() : null))
    .filter((e): e is FileSystemEntry => !!e);
  if (!entries.some((e) => e.isDirectory)) return { files: Array.from(dt.files), folderFiles: [], truncated: new Set() };
  return walkEntries(entries);
}

/**
 * Collects files from dropped entries, skipping OS junk. A folder that couldn't be read completely is listed in
 * `truncated` and must be rejected, never sent short.
 */
export async function walkEntries(entries: FileSystemEntry[]): Promise<Dropped> {
  const truncated = new Set<string>();
  const files: File[] = [];
  const folderFiles: FolderFile[] = [];
  const fileOf = (e: FileSystemFileEntry) => new Promise<File>((res, rej) => e.file(res, rej));
  const walk = async (dir: FileSystemDirectoryEntry, path: string): Promise<void> => {
    const top = path.split("/")[0];
    if (SKIP_DIRS.has(dir.name) && path.includes("/")) {
      folderFiles.push({ file: new File([], ".skipped"), rel: `${path}/.skipped` }); // lets toFolders report it
      return;
    }
    const reader = dir.createReader();
    // readEntries returns results in batches until it returns an empty list.
    for (;;) {
      let batch: FileSystemEntry[];
      try {
        batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      } catch {
        truncated.add(top); // a folder that can't be read completely is rejected, never sent short
        return;
      }
      if (!batch.length) break;
      for (const e of batch) {
        if (e.isDirectory) await walk(e as FileSystemDirectoryEntry, `${path}/${e.name}`);
        else if (JUNK_FILES.has(e.name)) continue;
        else {
          let file: File;
          try { file = await fileOf(e as FileSystemFileEntry); } catch { truncated.add(top); return; }
          folderFiles.push({ file, rel: `${path}/${e.name}` });
        }
      }
    }
  };
  for (const e of entries) {
    if (e.isDirectory) await walk(e as FileSystemDirectoryEntry, e.name);
    else files.push(await fileOf(e as FileSystemFileEntry));
  }
  return { files, folderFiles, truncated };
}
