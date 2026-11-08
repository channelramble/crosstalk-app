import { chmodSync, closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Room, Upload } from "@crosstalk/shared";
import { HttpError } from "./engine/engine";
import { entryPath, extractEntry, listZip, ZipError, type ZipEntry } from "./unzip";

/**
 * No size or file-count limits; the only guard is disk space. An upload is refused (or stopped) if it would
 * leave the hub with less than this much free, so a huge upload can't fill the disk and break the Mac.
 */
export const diskReserve = () => Number(process.env.CROSSTALK_UPLOAD_RESERVE_BYTES) || 2 * 1024 * 1024 * 1024;

function freeBytes(dir: string): number {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

const gb = (n: number) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : n >= 1024 ? `${Math.ceil(n / 1024)} KB` : `${Math.ceil(n)} bytes`;

/** Throws 507 if writing `bytes` into `dir` would leave less than the reserve free. */
function ensureSpace(dir: string, bytes: number): void {
  const free = freeBytes(dir);
  if (free - bytes < diskReserve()) {
    throw new HttpError(507, `Not enough free space on the hub: this needs ${gb(bytes)}, and ${gb(Math.max(0, free - diskReserve()))} is available (keeping ${gb(diskReserve())} free).`);
  }
}
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
// Any file or folder name a real project might use (accents, emoji, &, #, brackets…), minus separators and control characters.
const SEGMENT = /^(?!\.{1,2}$)[^/\\\u0000-\u001f]{1,200}$/;
const safeSegment = (name: string) => name.replace(/[/\\\u0000-\u001f]/g, "_").slice(0, 200);
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", heic: "image/heic", heif: "image/heif" };

function directory(room: Room): string {
  const root = realpathSync(room.cwd);
  let dir = root;
  for (const part of [".crosstalk", "uploads"]) {
    dir = join(dir, part);
    mkdirSync(dir, { recursive: true });
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new HttpError(400, "Upload folder must be a real directory inside the project");
  }
  return dir;
}

export function getUpload(room: Room, filename: string): Upload {
  // "<uuid>_<original name>": the name may be any real file name (accents, spaces, &, #…) but never a path.
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}_/.test(filename) || !SEGMENT.test(filename.slice(37))) throw new HttpError(400, "Invalid attachment");
  const path = join(directory(room), filename);
  let info;
  try { info = lstatSync(path); } catch { throw new HttpError(404, "Attachment not found"); }
  if (!info.isFile() || info.isSymbolicLink()) throw new HttpError(400, "Invalid attachment");
  const name = filename.slice(37);
  // encodeURIComponent leaves ( ) alone, and they'd end a Markdown link early.
  const url = `/api/rooms/${encodeURIComponent(room.id)}/uploads/${encodeURIComponent(filename).replace(/\(/g, "%28").replace(/\)/g, "%29")}`;
  return { filename, name, path, size: info.size, mimeType: TYPES[name.split(".").pop()!.toLowerCase()] ?? "application/octet-stream", url };
}

/** A folder path from the browser ("my-app/src/index.ts"), as safe segments. */
function folderSegments(relPath: string): string[] {
  const parts = relPath.split(/[\\/]/).filter(Boolean);
  if (parts.length < 2 || parts.length > 30 || parts.some((p) => p === "." || p === ".." || !SEGMENT.test(p))) throw new HttpError(400, `Unsupported file path in folder: ${relPath.slice(0, 200)}`);
  return parts;
}

/** Saves one file of a folder upload under uploads/<folderId>/<its path>, keeping the folder's structure. */
export async function saveFolderFile(room: Room, req: Request, folderId: string, relPath: string): Promise<{ folder: string; path: string }> {
  if (!UUID.test(folderId)) throw new HttpError(400, "Invalid folder upload");
  const parts = folderSegments(relPath);
  const uploads = directory(room);
  // Create the path one directory at a time, checking each existing one first, so a link planted anywhere
  // on the way can't make us create anything outside the upload folder.
  let dir = uploads;
  for (const part of [folderId, ...parts.slice(0, -1)]) {
    dir = join(dir, part);
    let info;
    try { info = lstatSync(dir); } catch { info = null; }
    if (!info) mkdirSync(dir);
    else if (!info.isDirectory() || info.isSymbolicLink()) throw new HttpError(400, "Invalid folder upload");
  }
  const base = join(uploads, folderId);
  const target = join(dir, parts[parts.length - 1]);
  // A retry after a dropped response may resend a file that was saved: overwrite it, but never through a symlink.
  let existing;
  try { existing = lstatSync(target); } catch { existing = null; }
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new HttpError(400, "Invalid folder upload");
  // Upload beside it and swap in only once complete, so an interrupted retry never loses the saved copy.
  const temp = join(dir, `.${crypto.randomUUID()}.uploading`);
  await streamToFile(req, temp);
  try {
    renameSync(temp, target);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
  return { folder: `${folderId}/${parts[0]}`, path: target };
}

// OS clutter that's never project content; skipped when unpacking and not counted.
const ZIP_JUNK = /(^__MACOSX\/|(^|\/)\.DS_Store$|(^|\/)Thumbs\.db$)/;

/**
 * Unpacks an uploaded .zip of a folder (phones can't pick folders, but can zip one). Checks every entry name
 * and the unpacked size before extracting, and rejects archives that contain links.
 */
export async function saveZipFolder(room: Room, req: Request, name: string): Promise<{ folder: string; path: string; files: number }> {
  const raw = safeSegment(name.replace(/\.zip$/i, "").split(/[\\/]/).pop() ?? "");
  const folderName = SEGMENT.test(raw) ? raw : "folder";
  const id = crypto.randomUUID();
  const base = join(directory(room), id);
  const staging = join(base, ".unpack");
  mkdirSync(staging, { recursive: true });
  const zip = join(base, "upload.zip");
  try {
    await streamToFile(req, zip);
    let entries;
    try {
      entries = await listZip(zip);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : "That file isn't a readable .zip");
    }
    // Check the whole archive before writing anything.
    const files: { entry: ZipEntry; name: string }[] = [];
    const seen = new Set<string>();
    let total = 0;
    for (const entry of entries) {
      const name = entry.name.replace(/\\/g, "/");
      const parts = name.split("/").filter(Boolean);
      if (name.startsWith("/") || /^[A-Za-z]:/.test(name) || parts.some((p) => !SEGMENT.test(p)) || parts.length > 40) throw new HttpError(400, `The .zip contains an unsafe path: ${name.slice(0, 200)}`);
      if (entry.isLink) throw new HttpError(400, "The .zip contains links, which aren't allowed");
      if (entry.isDir || ZIP_JUNK.test(name)) continue;
      if (entry.flags & 0x1) throw new HttpError(400, "The .zip is password-protected; send an unprotected one");
      // macOS folders are case-insensitive, so "A.txt" and "a.txt" would overwrite each other.
      const key = parts.join("/").normalize("NFC").toLowerCase();
      if (seen.has(key)) throw new HttpError(400, `The .zip has two files named ${parts.join("/")} (differing only in upper/lower case)`);
      seen.add(key);
      total += entry.size;
      files.push({ entry, name: parts.join("/") });
    }
    if (!files.length) throw new HttpError(400, "The .zip is empty");
    // Unpacking needs room for the files while the .zip is still on disk.
    ensureSpace(staging, total);
    for (const f of files) {
      try {
        await extractEntry(zip, f.entry, entryPath(staging, f.name));
      } catch (e) {
        throw new HttpError(400, e instanceof ZipError ? e.message : `Couldn't unpack ${f.name}`);
      }
    }
    // Check what actually landed, not just what the archive promised.
    if (countFiles(staging) !== files.length) throw new HttpError(400, "Couldn't unpack every file in the .zip");
    // A zip of one folder unpacks to that folder; otherwise wrap the loose files in a folder named after the zip.
    const top = readdirSync(staging);
    const single = top.length === 1 && lstatSync(join(staging, top[0])).isDirectory();
    const finalName = single && SEGMENT.test(top[0]) ? top[0] : folderName;
    const target = join(base, finalName);
    renameSync(single ? join(staging, top[0]) : staging, target);
    return { folder: `${id}/${finalName}`, path: target, files: countFiles(target) };
  } catch (e) {
    rmSync(base, { recursive: true, force: true });
    throw e;
  } finally {
    rmSync(zip, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

function countFiles(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(join(dir, e.name)) : 1;
  return n;
}

/**
 * Streams a request body to disk without holding it in memory, never eating into the free-space reserve:
 * every chunk is checked against the space left before it's written (re-measured every 64 MB and whenever the
 * budget runs short), and the result is checked again once flushed. Any failure removes the partial file.
 */
async function streamToFile(req: Request, path: string): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf("/"));
  const lowSpace = () => new HttpError(507, `Not enough free space on the hub for this upload (keeping ${gb(diskReserve())} free).`);
  ensureSpace(dir, Number(req.headers.get("content-length")) || 0);
  writeFileSync(path, "", { flag: "wx", mode: 0o600 });
  let sink: ReturnType<ReturnType<typeof Bun.file>["writer"]> | null = null;
  const reader = req.body?.getReader();
  let ok = false;
  try {
    sink = Bun.file(path).writer();
    let budget = freeBytes(dir) - diskReserve();
    let sinceMeasure = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > budget || sinceMeasure > 64 * 1024 * 1024) {
        await sink.flush();
        budget = freeBytes(dir) - diskReserve();
        sinceMeasure = 0;
        if (value.byteLength > budget) { await reader.cancel().catch(() => {}); throw lowSpace(); }
      }
      sink.write(value);
      budget -= value.byteLength;
      sinceMeasure += value.byteLength;
    }
    await sink.flush();
    if (freeBytes(dir) < diskReserve()) throw lowSpace();
    ok = true;
  } finally {
    reader?.releaseLock();
    try { await sink?.end(); } catch { ok = false; }
    if (!ok) rmSync(path, { force: true });
  }
}

/**
 * The original file name, kept as is except for path separators and control characters, and shortened (keeping
 * the extension) so "<uuid>_<name>" stays well under the 255-byte file-name limit.
 */
function storedName(name: string): string {
  let n = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f]/g, "_").trim(); // shortened below, keeping the extension
  const enc = new TextEncoder();
  if (enc.encode(n).length > 200) {
    const dot = n.lastIndexOf(".");
    const ext = dot > 0 && n.length - dot <= 16 ? n.slice(dot) : "";
    let stem = n.slice(0, n.length - ext.length);
    while (enc.encode(stem + ext).length > 200) stem = stem.slice(0, -1);
    n = stem + ext;
  }
  return SEGMENT.test(n) ? n : "file";
}

export async function saveUpload(room: Room, req: Request, name: string): Promise<Upload> {
  const safeName = storedName(name);
  const filename = `${crypto.randomUUID()}_${safeName}`;
  await streamToFile(req, join(directory(room), filename));
  return getUpload(room, filename);
}

/** An uploaded folder's directory, after checking it's a real folder inside the upload area. */
export function folderPath(room: Room, id: string, name: string): string {
  if (!UUID.test(id) || !SEGMENT.test(name)) throw new HttpError(400, "Invalid folder");
  const uploads = directory(room);
  // Check every level, not just the last: a link anywhere on the way could point outside the upload area.
  let path = uploads;
  for (const part of [id, name]) {
    path = join(path, part);
    let info;
    try { info = lstatSync(path); } catch { throw new HttpError(404, "Folder not found"); }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new HttpError(400, "Invalid folder");
  }
  if (!realpathSync(path).startsWith(realpathSync(uploads) + "/")) throw new HttpError(400, "Invalid folder");
  return path;
}

/** Lists an uploaded folder's files (relative paths and sizes) so the chat can show what's inside. */
export function listFolder(room: Room, id: string, name: string, offset = 0, limit = 1000): { name: string; files: { path: string; size: number }[]; total: number; offset: number } {
  const root = folderPath(room, id, name);
  const files: { path: string; size: number }[] = [];
  let total = 0;
  offset = Math.max(0, Math.floor(offset) || 0);
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isSymbolicLink()) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), p);
      else if (e.isFile()) {
        if (total >= offset && files.length < limit) files.push({ path: p, size: lstatSync(join(dir, e.name)).size });
        total++;
      }
    }
  };
  walk(root, "");
  return { name, files, total, offset };
}

/** One file inside an uploaded folder, for opening from the chat. */
export function folderFile(room: Room, id: string, name: string, rel: string): { path: string; name: string } {
  const parts = rel.split("/").filter(Boolean);
  if (!parts.length || parts.length > 40 || parts.some((p) => !SEGMENT.test(p))) throw new HttpError(400, "Invalid file");
  let path = folderPath(room, id, name);
  for (const part of parts) {
    path = join(path, part);
    let info;
    try { info = lstatSync(path); } catch { throw new HttpError(404, "File not found"); }
    if (info.isSymbolicLink()) throw new HttpError(400, "Invalid file");
  }
  if (!lstatSync(path).isFile()) throw new HttpError(400, "Invalid file");
  return { path, name: parts[parts.length - 1] };
}

/**
 * A file anywhere in the room's project folder, for download links agents put in their replies
 * (e.g. [release.zip](/Users/me/project/release.zip) or [app](dist/app.zip)). Must resolve inside the folder.
 */
export function projectFile(room: Room, requested: string): { path: string; name: string; size: number } {
  if (!requested || requested.includes("\0")) throw new HttpError(400, "Invalid file");
  const root = realpathSync(room.cwd);
  const raw = resolve(room.cwd, requested);
  // Refuse anything that points outside the folder before looking at the disk at all.
  if (!raw.startsWith(resolve(room.cwd) + "/") && !raw.startsWith(root + "/")) throw new HttpError(403, "That file is outside this room's project folder");
  let real;
  try { real = realpathSync(raw); } catch { throw new HttpError(404, "That file doesn't exist (anymore) in the project folder"); }
  if (!real.startsWith(root + "/")) throw new HttpError(403, "That file is outside this room's project folder");
  const info = lstatSync(real);
  if (info.isDirectory()) throw new HttpError(400, "That's a folder; ask the agent to zip it and link the .zip");
  if (!info.isFile()) throw new HttpError(400, "Invalid file");
  return { path: real, name: real.split("/").pop()!, size: info.size };
}

export function attachmentText(room: Room, filenames: unknown): string {
  if (filenames === undefined) return "";
  if (!Array.isArray(filenames) || filenames.some((f) => typeof f !== "string")) throw new HttpError(400, "Invalid attachments");
  const unique = [...new Set(filenames as string[])];
  const lines = unique.map((f) => {
    if (!f.startsWith("folder:")) {
      const u = getUpload(room, f);
      return `- [${u.name.replace(/[[\]\\]/g, "\\$&")}](${u.url}) — local path: ${JSON.stringify(u.path)}`;
    }
    const [id, name, ...rest] = f.slice(7).split("/");
    if (rest.length || !UUID.test(id) || !SEGMENT.test(name ?? "") || name === "." || name === "..") throw new HttpError(400, "Invalid attachment");
    const path = folderPath(room, id, name);
    const n = countFiles(path);
    // encodeURIComponent leaves ( ) as is, and they'd end or break the Markdown link.
    const url = `/api/rooms/${encodeURIComponent(room.id)}/folders/${id}/${encodeURIComponent(name).replace(/\(/g, "%28").replace(/\)/g, "%29")}`;
    return `- [${name.replace(/[[\]]/g, "\\$&")}/](${url}) (${n} file${n === 1 ? "" : "s"}) — local path: ${JSON.stringify(path)}`;
  });
  return lines.length ? "\n\nAttachments (open these local files only if needed):\n" + lines.join("\n") : "";
}

/** Images an agent's reply can show: the formats the chat previews (never SVG, which can carry scripts). */
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|heic|heif)$/i;
/** Bigger images stay plain links: a reply shouldn't copy huge files into the chat. */
export const SHARE_IMAGE_LIMIT = 50 * 1024 * 1024;
// Code (fenced blocks and `inline`) is left exactly as written; only the prose around it is looked at.
const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/;
// [label](target "title") and ![alt](target): the target may contain spaces (agents often skip the <…> CommonMark wants).
const MD_LINK = /(!?)\[((?:\\.|[^\]\\\n])*)\]\(\s*(<[^>\n]+>|[^)\n]*?)(\s+"[^"\n]*")?\s*\)/g;
// A local image wrapped in a link ([![a](x.png)](x.png)) is shown once, as the image (web badges keep their links).
const LINKED_IMAGE = /\[(!\[(?:\\.|[^\]\\\n])*\]\(([^)\n]+)\))\]\([^)\n]+\)/g;

/** A link target that names an image file on this Mac (absolute, ~/, file:// or relative to the room's folder). */
function localImage(room: Pick<Room, "cwd">, target: string): string | null {
  let h = target.trim();
  if (h.startsWith("<") && h.endsWith(">")) h = h.slice(1, -1).trim();
  if (!h || h.startsWith("#") || h.startsWith("/api/") || h.startsWith("//")) return null;
  if (/^file:\/\//i.test(h)) h = h.replace(/^file:\/\/(localhost)?/i, "");
  else if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return null; // https:, data:, mailto:, …
  try { h = decodeURIComponent(h); } catch { /* keep as written */ }
  if (h.startsWith("~/")) h = join(homedir(), h.slice(2));
  const path = resolve(room.cwd, h);
  return IMAGE_FILE.test(path) ? path : null;
}

/** Whether the file starts like a PNG, JPEG, GIF, WebP, AVIF or HEIC image (not just named like one). */
function isImageData(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const b = Buffer.alloc(12);
    if (readSync(fd, b, 0, 12, 0) < 12) return false;
    const at = (start: number, end: number) => b.toString("latin1", start, end);
    return (b[0] === 0x89 && at(1, 4) === "PNG") || (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || at(0, 4) === "GIF8" || (at(0, 4) === "RIFF" && at(8, 12) === "WEBP") || at(4, 8) === "ftyp";
  } finally {
    closeSync(fd);
  }
}

/** Copies an image into the room's uploads and returns its chat URL; null if it can't be shared (left as a link). */
function shareImage(room: Room, path: string): string | null {
  try {
    const real = realpathSync(path);
    if (!IMAGE_FILE.test(real)) return null; // a link named .png that points at something else
    const info = statSync(real);
    if (!info.isFile() || info.size > SHARE_IMAGE_LIMIT || !isImageData(real)) return null;
    const dir = directory(room);
    // Already in this chat's uploads (a picture the human sent, or one copied there by hand): use it as it is.
    if (dirname(real) === dir && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}_/.test(basename(real))) return getUpload(room, basename(real)).url;
    ensureSpace(dir, info.size);
    const filename = `${crypto.randomUUID()}_${storedName(basename(real))}`;
    const target = join(dir, filename);
    copyFileSync(real, target, constants.COPYFILE_EXCL);
    chmodSync(target, 0o600);
    return getUpload(room, filename).url;
  } catch {
    return null;
  }
}

/**
 * Makes the images an agent links in its reply show in the chat: each one that names an image file on this Mac
 * (anywhere, not only in the room's folder) is copied into the chat's uploads and the link points there. The chat
 * keeps that copy, so it still shows after the original is changed or deleted. Code is left alone.
 */
export function shareImages(room: Room, text: string): string {
  if (!text.includes("](")) return text;
  const shared = new Map<string, string | null>();
  const share = (target: string) => {
    const path = localImage(room, target);
    if (!path) return null;
    if (!shared.has(path)) shared.set(path, shareImage(room, path));
    return shared.get(path) ?? null;
  };
  return text
    .split(CODE)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(LINKED_IMAGE, (whole, image: string, target: string) => (localImage(room, target) ? image : whole)).replace(MD_LINK, (whole, bang: string, label: string, target: string, title?: string) => {
            const url = share(target);
            if (!url) return whole;
            const name = label.trim() ? label : basename(localImage(room, target)!).replace(/[[\]\\]/g, "\\$&");
            return `${bang}[${name}](${url}${title ?? ""})`;
          }),
    )
    .join("");
}

/** A room's upload folder, when it's there and a real folder inside the project (nothing is made). */
function existingDirectory(room: Pick<Room, "cwd">): string | null {
  try {
    let dir = realpathSync(room.cwd);
    for (const part of [".crosstalk", "uploads"]) {
      dir = join(dir, part);
      const info = lstatSync(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) return null;
    }
    return dir;
  } catch {
    return null;
  }
}

/** How much a file or folder holds, links not followed. */
function entrySize(path: string): number {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return 0;
  if (!info.isDirectory()) return info.size;
  let n = 0;
  for (const name of readdirSync(path)) n += entrySize(join(path, name));
  return n;
}

/** Copies a file or folder (never through a link, never over anything), readable only by this user. */
function copyEntry(from: string, to: string) {
  const info = lstatSync(from);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    mkdirSync(to, { mode: 0o700 });
    for (const name of readdirSync(from)) copyEntry(join(from, name), join(to, name));
  } else if (info.isFile()) {
    copyFileSync(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    chmodSync(to, 0o600);
  }
}

/** The most a duplicated chat copies of the original's uploads; links to anything beyond it stay on the original. */
const COPY_UPLOADS_MAX = 2 * 1024 ** 3;

/** What a duplicated chat's messages have copied of the original's uploads so far (see moveUploadLinks). */
export interface UploadCopies {
  /** Each upload ("<uuid>_<name>" for a file, "<uuid>" for a folder): true when it's in the copy's folder. */
  entries: Map<string, boolean>;
  bytes: number;
}

/**
 * A message a duplicated chat copies, with its links to the original chat's uploads (files and folders sent in it,
 * images its agent showed) moved to the copy, so they still open once the original is deleted. A copy in another folder
 * first gets its own copy of each of those files (and the local paths in the message name it), so the original's
 * clean-up can't take them; one that can't be copied (gone, too big, or no room on the disk) keeps its link to the
 * original. `copies` is shared by a chat's messages.
 */
export function moveUploadLinks(from: Room, to: Room, text: string, copies: UploadCopies = { entries: new Map(), bytes: 0 }): string {
  if (!text.includes("/api/rooms/")) return text;
  const fromDir = existingDirectory(from);
  if (!fromDir) return text;
  let same = false;
  try {
    same = realpathSync(from.cwd) === realpathSync(to.cwd);
  } catch {
    // the copy's folder isn't there: never the same
  }
  const dest = { dir: null as string | null };
  const moved = new Set<string>();
  const take = (entry: string): boolean => {
    if (same) return true;
    let ok = copies.entries.get(entry);
    if (ok === undefined) {
      ok = false;
      try {
        const toDir = (dest.dir ??= directory(to));
        const target = join(toDir, entry);
        if (existsSync(target)) ok = true;
        else {
          const size = entrySize(join(fromDir, entry));
          if (copies.bytes + size <= COPY_UPLOADS_MAX) {
            ensureSpace(toDir, size);
            copyEntry(join(fromDir, entry), target);
            copies.bytes += size;
            ok = true;
          }
        }
      } catch {
        ok = false;
      }
      copies.entries.set(entry, ok);
    }
    if (ok) moved.add(entry);
    return ok;
  };
  const room = encodeURIComponent(from.id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const out = text.replace(new RegExp(`/api/rooms/${room}/(uploads|folders)/([^\\s)"'<>]+)`, "g"), (whole, kind: string, rest: string) => {
    let entry: string;
    try {
      entry = kind === "uploads" ? decodeURIComponent(rest) : rest.split("/")[0];
    } catch {
      return whole;
    }
    const valid = kind === "uploads" ? /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}_/.test(entry) && SEGMENT.test(entry.slice(37)) : UUID.test(entry);
    return valid && take(entry) ? `/api/rooms/${encodeURIComponent(to.id)}/${kind}/${rest}` : whole;
  });
  // The local paths the message gives its agent name the copy's files.
  const toDir = dest.dir ?? (moved.size ? directory(to) : null);
  if (same || !toDir) return out;
  let result = out;
  for (const entry of moved) result = result.split(`${fromDir}/${entry}`).join(`${toDir}/${entry}`);
  return result;
}

const UUID_ANYWHERE = /[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/g;

/**
 * Deletes uploads that never made it into a message (removed before sending, or left by a closed tab) once
 * they're older than `olderThanMs`. Anything a message links to is kept. Returns how many entries were removed.
 */
export function cleanupUploads(room: Pick<Room, "cwd">, messageTexts: string[], olderThanMs = 24 * 60 * 60_000): number {
  // Check every level (.crosstalk, then uploads) without creating anything: a link at either one could point
  // somewhere outside the project, and deleting there would be a disaster.
  let dir: string;
  try {
    const root = realpathSync(room.cwd);
    dir = root;
    for (const part of [".crosstalk", "uploads"]) {
      dir = join(dir, part);
      const info = lstatSync(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) return 0;
    }
    if (realpathSync(dir) !== join(root, ".crosstalk", "uploads")) return 0;
  } catch {
    return 0; // no uploads yet
  }
  const used = new Set(messageTexts.flatMap((t) => t.match(UUID_ANYWHERE) ?? []));
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const id = name.slice(0, 36);
    if (!UUID.test(id) || used.has(id)) continue;
    const path = join(dir, name);
    try {
      if (lstatSync(path).mtimeMs > cutoff) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch {
      /* raced with another delete; fine */
    }
  }
  return removed;
}
