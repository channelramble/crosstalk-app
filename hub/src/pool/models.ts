// Models for the pool from Hugging Face (docs/MODEL-POOL.md): a repo's GGUF files grouped into models, downloads to
// ~/.crosstalk/models/<owner>/<repo>/ that pick up where they stopped, and moving model files to the Trash. Settings →
// Local models downloads with the same code into a folder of the person's choosing (`root`; the pool's by default).

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type { PoolModel, PoolModelChoices, PoolModelFile } from "@crosstalk/shared";
import { HOME, HUB_VERSION } from "../config";
import { HttpError } from "../engine/engine";
import { diskSpace } from "../storage";
import { diskReserve } from "../uploads";
import { logger } from "../util/log";
import { errText, gb } from "./llama";

const log = logger("pool");

/** Where models are downloaded: <owner>/<repo>/<file>. */
export const modelsDir = () => join(HOME, "models");
/** Hugging Face (tests point it at a fake). */
export const hfBase = () => (process.env.CROSSTALK_HF_URL ?? "https://huggingface.co").replace(/\/+$/, "");

/** A split model's part: <name>-00001-of-00003.gguf. */
export const SPLIT_RE = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;
/** One part of a Hugging Face repo id (owner or name). */
const REPO_PART = /^(?!.*\.\.)[A-Za-z0-9_][\w.-]{0,95}$/;
/** One folder or file name in a repo: never "." or "..", hidden, or with separators or control characters. */
const FILE_PART = /^(?!\.)[^/\\\u0000-\u001f\u007f]{1,200}$/;

const inside = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);
const sizeOf = (path: string): number | null => {
  try {
    const s = lstatSync(path);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
};

export function checkRepo(repo: unknown): string {
  const parts = typeof repo === "string" ? repo.split("/") : [];
  if (parts.length !== 2 || !parts.every((p) => REPO_PART.test(p))) throw new HttpError(400, "Pick a Hugging Face model like owner/model-GGUF.");
  return repo as string;
}

/** A GGUF file's path in its repo, e.g. "Q4_K_M/Model-Q4_K_M-00001-of-00002.gguf". */
export function checkFile(file: unknown): string {
  const parts = typeof file === "string" ? file.split("/") : [];
  if (!parts.length || parts.length > 4 || !parts.every((p) => FILE_PART.test(p)) || !/\.gguf$/i.test(file as string)) {
    throw new HttpError(400, "Pick the model's GGUF file from its Hugging Face repo.");
  }
  return file as string;
}

/** Vision add-ons (mmproj) and importance matrices are GGUF files too, but not models. */
export const isNotModel = (file: string) => /mmproj|imatrix/i.test(file);

/**
 * A model as another hub sent it, checked strictly: a real repo id, GGUF files inside it, and for a split model all of
 * its parts in order.
 */
export function checkModel(x: unknown): PoolModel {
  if (!x || typeof x !== "object") throw new HttpError(400, "Pick a model.");
  const m = x as Record<string, unknown>;
  const repo = checkRepo(m.repo);
  if (!Array.isArray(m.files) || m.files.length < 1 || m.files.length > 256) throw new HttpError(400, "Pick the model's GGUF file from its Hugging Face repo.");
  const files = m.files.map(checkFile);
  if (files.some(isNotModel)) throw new HttpError(400, "That file isn't a model (it's a vision add-on or an importance matrix): pick the model's own GGUF file.");
  const split = files.map((f) => SPLIT_RE.exec(f));
  if (files.length > 1 || split[0]) {
    const first = split[0];
    const whole = !!first && split.every((s, i) => !!s && s[1] === first[1] && Number(s[3]) === files.length && Number(s[2]) === i + 1);
    if (!whole) throw new HttpError(400, "A split model needs all of its parts, in order (…-00001-of-00003.gguf, …-00002-of-00003.gguf, …).");
  }
  const sizeBytes = Number(m.sizeBytes ?? 0);
  if (!Number.isSafeInteger(Math.floor(sizeBytes)) || sizeBytes < 0) throw new HttpError(400, "The model's size is wrong: pick the model again.");
  if (m.quant !== undefined && m.quant !== null && (typeof m.quant !== "string" || m.quant.length > 40)) throw new HttpError(400, "The model's quant is wrong: pick the model again.");
  return { repo, files, quant: typeof m.quant === "string" ? m.quant : null, sizeBytes: Math.floor(sizeBytes), gated: m.gated === true };
}

/** The repo (and the file, for a link to one) from "owner/repo", a repo link or a file link (…/blob/main/x.gguf). */
export function parseRepoInput(input: string): { repo: string; file: string | null } {
  const s = String(input ?? "").trim();
  const bad = () => new HttpError(400, "Paste a Hugging Face link or a model name like owner/model-GGUF.");
  if (!s) throw bad();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^(www\.)?(huggingface\.co|hf\.co)\//i.test(s)) return { repo: checkRepo(s.replace(/\/+$/, "")), file: null };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    throw bad();
  }
  const hosts = new Set(["huggingface.co", "www.huggingface.co", "hf.co", new URL(hfBase()).host]);
  if (!hosts.has(url.host)) throw new HttpError(400, "That isn't a Hugging Face link: paste one from huggingface.co, or a model name like owner/model-GGUF.");
  let parts: string[];
  try {
    parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw bad();
  }
  if (parts[0] === "models") parts = parts.slice(1);
  if (parts[0] === "datasets" || parts[0] === "spaces") throw new HttpError(400, "That's a Hugging Face dataset or space, not a model: paste a model's link.");
  if (parts.length < 2) throw bad();
  const repo = checkRepo(`${parts[0]}/${parts[1]}`);
  if ((parts[2] === "blob" || parts[2] === "resolve") && parts.length >= 5) return { repo, file: checkFile(parts.slice(4).join("/")) };
  return { repo, file: null };
}

const QUANT = /(?<=^|[-_.\s/])(UD-)?(IQ[1-4]_(?:XXS|XS|NL|S|M)|Q[2-8]_K(?:_(?:XL|S|M|L))?|Q[4-8]_[01](?:_\d_\d)?|TQ[12]_0|MXFP4(?:_MOE)?|NVFP4|BF16|F16|F32|FP16|FP8)(?=$|[-_.\s])/gi;

/** The quant from a file name: Q4_K_M, IQ4_XS, UD-Q6_K_XL, MXFP4, F16, BF16, Q8_0… (null when the name doesn't say). */
export function quantOf(file: string): string | null {
  const name = basename(file).replace(/\.gguf$/i, "").replace(/-\d{5}-of-\d{5}$/i, "");
  let last: RegExpMatchArray | null = null;
  for (const m of name.matchAll(QUANT)) last = m;
  return last ? `${last[1] ? "UD-" : ""}${last[2].toUpperCase()}` : null;
}

/** A repo's GGUF files as models: single files, and split models whose parts are all there; smallest first. */
export function groupModels(repo: string, files: { path: string; size: number }[], gated: boolean): PoolModel[] {
  const models: PoolModel[] = [];
  const splits = new Map<string, { total: number; parts: Map<number, { path: string; size: number }> }>();
  const downloadable = (path: string) => {
    try {
      checkFile(path);
      return true;
    } catch {
      return false;
    }
  };
  for (const f of files) {
    // Only what a machine will download: GGUF models (never vision add-ons) at paths it accepts.
    if (!/\.gguf$/i.test(f.path) || isNotModel(f.path) || !downloadable(f.path)) continue;
    const m = SPLIT_RE.exec(f.path);
    if (!m) {
      models.push({ repo, files: [f.path], quant: quantOf(f.path), sizeBytes: f.size, gated });
      continue;
    }
    const key = `${m[1]}\u0000${m[3]}`;
    const group = splits.get(key) ?? { total: Number(m[3]), parts: new Map() };
    group.parts.set(Number(m[2]), f);
    splits.set(key, group);
  }
  for (const g of splits.values()) {
    const parts = Array.from({ length: g.total }, (_, i) => g.parts.get(i + 1));
    // A model missing a part can't be loaded.
    if (!g.total || parts.some((p) => !p)) continue;
    const whole = parts as { path: string; size: number }[];
    models.push({ repo, files: whole.map((p) => p.path), quant: quantOf(whole[0].path), sizeBytes: whole.reduce((n, p) => n + p.size, 0), gated });
  }
  return models.sort((a, b) => a.sizeBytes - b.sizeBytes || a.files[0].localeCompare(b.files[0]));
}

/**
 * Fetches from Hugging Face, following redirects itself so the token only ever goes to Hugging Face (downloads are
 * redirected to its storage, which needs none). Never logs the token. `linkedSize`: a file's size as Hugging Face
 * gave it on the way (X-Linked-Size).
 */
export async function hfFetch(url: string, token: string | null | undefined, init: { headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<{ res: Response; linkedSize: number | null }> {
  const base = new URL(hfBase());
  let current = new URL(url);
  let linkedSize: number | null = null;
  for (let hop = 0; hop < 8; hop++) {
    const own = current.origin === base.origin;
    const headers: Record<string, string> = { "user-agent": `crosstalk-hub/${HUB_VERSION}`, ...init.headers };
    if (token && own) headers.authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await fetch(current, { headers, redirect: "manual", signal: init.signal });
    } catch (e) {
      if (init.signal?.aborted) throw stopped();
      throw new HttpError(502, `Couldn't reach Hugging Face (${errText(e)}): check this machine's internet connection, then try again.`);
    }
    // Hugging Face says a file's size on the way to its storage, which may not (a chunked response).
    const linked = Number(res.headers.get("x-linked-size"));
    if (linked > 0 && linkedSize === null) linkedSize = linked;
    const location = res.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(res.status) || !location) return { res, linkedSize };
    await res.body?.cancel().catch(() => {});
    const next = new URL(location, current);
    // Never from https down to http (only a test Hugging Face is plain http).
    if (next.protocol !== "https:" && !(next.protocol === "http:" && base.protocol === "http:")) throw new HttpError(502, "Hugging Face sent the download somewhere unsafe: try again later.");
    current = next;
  }
  throw new HttpError(502, "Hugging Face redirected too many times: try again in a few minutes.");
}

export function repoError(res: Response, repo: string, token: string | null | undefined): HttpError {
  if (res.status === 401 && token) return new HttpError(401, "Hugging Face didn't accept the saved token: make a new one on huggingface.co (Settings → Access Tokens) and save it.");
  if (res.status === 401 || res.status === 404) return new HttpError(404, `Couldn't find ${repo} on Hugging Face: check the name. If it's private, save a Hugging Face token first.`);
  if (res.status === 403) return termsError(repo);
  if (res.status === 429) return new HttpError(503, "Hugging Face is limiting requests from this machine: try again in a few minutes.");
  return new HttpError(502, `Hugging Face answered ${res.status}: try again in a few minutes.`);
}

const termsError = (repo: string) =>
  new HttpError(403, `Hugging Face won't let this download ${repo} yet: open huggingface.co/${repo}, accept the model's terms, then save a Hugging Face token (from the same account) and try again.`, "hf_terms");

/** The next page of a Hugging Face listing, from its Link header (only ever on Hugging Face itself). */
function nextPage(link: string | null): string | null {
  const m = link ? /<([^>]+)>\s*;\s*rel="?next"?/i.exec(link) : null;
  if (!m) return null;
  try {
    const url = new URL(m[1], hfBase());
    return url.origin === new URL(hfBase()).origin ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * A Hugging Face repo's GGUF models (from "owner/repo", a repo link or a file link): split models grouped in order,
 * vision add-ons left out, smallest first; for a file link, that file's model first.
 */
export async function choices(repoOrUrl: string, token?: string | null): Promise<PoolModelChoices> {
  const { repo, file } = parseRepoInput(repoOrUrl);
  const { res: infoRes } = await hfFetch(`${hfBase()}/api/models/${repo}`, token, { signal: AbortSignal.timeout(30_000) });
  if (!infoRes.ok) throw repoError(infoRes, repo, token);
  const info = (await infoRes.json().catch(() => null)) as { gated?: unknown } | null;
  const gated = !!info?.gated;
  const files: { path: string; size: number }[] = [];
  let next: string | null = `${hfBase()}/api/models/${repo}/tree/main?recursive=true`;
  for (let page = 0; next && page < 50; page++) {
    const { res } = await hfFetch(next, token, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw repoError(res, repo, token);
    const list = (await res.json().catch(() => null)) as { type?: unknown; path?: unknown; size?: unknown; lfs?: { size?: unknown } }[] | null;
    if (!Array.isArray(list)) throw new HttpError(502, "Hugging Face sent a file list Crosstalk can't read: try again in a few minutes.");
    for (const e of list) {
      if (e?.type !== "file" || typeof e.path !== "string") continue;
      files.push({ path: e.path, size: Number(e.lfs?.size ?? e.size) || 0 });
    }
    next = nextPage(res.headers.get("link"));
  }
  let models = groupModels(repo, files, gated);
  if (!models.length) throw new HttpError(404, `${repo} has no GGUF model files: pick a repo with GGUF files (their names usually end in -GGUF).`);
  if (file) {
    const i = models.findIndex((m) => m.files.includes(file));
    if (i > 0) models = [models[i], ...models.slice(0, i), ...models.slice(i + 1)];
  }
  return { repo, gated, models };
}

/**
 * The first `maxBytes` of one of a repo's files (a GGUF file's header: what the model is built like), asked with a
 * Range so only that much comes; a server that sends the whole file anyway is cut off there. Null when it can't be read.
 */
export async function fileHead(repo: string, file: string, token: string | null | undefined, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array | null> {
  const url = `${hfBase()}/${checkRepo(repo)}/resolve/main/${checkFile(file).split("/").map(encodeURIComponent).join("/")}`;
  let res: Response;
  try {
    ({ res } = await hfFetch(url, token, { headers: { range: `bytes=0-${maxBytes - 1}` }, signal: signal ?? AbortSignal.timeout(30_000) }));
  } catch {
    return null;
  }
  if ((res.status !== 200 && res.status !== 206) || !res.body) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const out = new Uint8Array(maxBytes);
  let have = 0;
  const reader = res.body.getReader();
  try {
    while (have < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, maxBytes - have);
      out.set(value.subarray(0, take), have);
      have += take;
    }
  } catch {
    return have ? out.subarray(0, have) : null;
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out.subarray(0, have);
}

/** The folder a repo's files go in (in `root`, the models folder by default). */
export function repoDir(repo: string, root = modelsDir()): string {
  const [owner, name] = checkRepo(repo).split("/");
  return join(root, owner, name);
}

/** Where one of a repo's files goes (never outside its folder). */
export function filePath(repo: string, file: string, root = modelsDir()): string {
  const dir = repoDir(repo, root);
  const path = resolve(dir, checkFile(file));
  if (!inside(path, dir) || path === dir) throw new HttpError(400, "Pick the model's GGUF file from its Hugging Face repo.");
  return path;
}

/** Every file of a model, where it's downloaded. */
export function modelFiles(model: PoolModel, root = modelsDir()): string[] {
  return model.files.map((f) => filePath(model.repo, f, root));
}

/** The model's first file: what llama-server is given (it finds a split model's other parts beside it). */
export function modelPath(model: PoolModel, root = modelsDir()): string {
  return modelFiles(model, root)[0];
}

/** All of the model's files are downloaded. */
export function haveModel(model: PoolModel, root = modelsDir()): boolean {
  return modelFiles(model, root).every((p) => sizeOf(p) !== null);
}

/** The nearest folder that exists, for measuring free space before the model's folder is made. */
export function existingParent(path: string): string {
  let p = path;
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  return p;
}

/** Bytes still to download (what isn't on disk yet, finished or in a .part file) and the free space. */
export function spaceFor(model: PoolModel, root = modelsDir()): { remaining: number; free: number } {
  let have = 0;
  for (const p of modelFiles(model, root)) have += sizeOf(p) ?? sizeOf(`${p}.part`) ?? 0;
  return { remaining: Math.max(0, model.sizeBytes - have), free: diskSpace(existingParent(repoDir(model.repo, root))).free };
}

/** Refuses a download that would leave less than the hub's reserve (2 GB) free. */
export function checkSpace(model: PoolModel, root = modelsDir()): void {
  const { remaining, free } = spaceFor(model, root);
  if (free < remaining + diskReserve()) {
    throw new HttpError(
      507,
      `Not enough free space for ${model.repo}${model.quant ? ` (${model.quant})` : ""}: it needs ${gb(remaining)} more and ${gb(Math.max(0, free - diskReserve()))} is free (keeping ${gb(diskReserve())} free). Free up space or pick a smaller quant.`,
      "low_disk",
    );
  }
}

export interface DownloadProgress {
  /** The file being downloaded (its path in the repo). */
  file: string;
  doneBytes: number;
  totalBytes: number;
  bytesPerSec: number | null;
}

const stopped = () => new HttpError(409, "The download was stopped.", "stopped");

/** What downloads models with this code (the pool, Settings → Local models), and what the other is told while one does. */
export const DOWNLOADERS = {
  pool: "The model pool is downloading this model: wait for it, or cancel it in Model pool.",
  local: "Settings → Local models is downloading this model: wait for it, or stop it there.",
} as const;
export type Downloader = keyof typeof DOWNLOADERS;

/**
 * The model files being downloaded now (by where they really go) and what downloads each. The pool and Local models
 * share the default folder: two downloads of one file would write the same .part, and the file put in place would be
 * neither's.
 */
const writing = new Map<string, Downloader>();
const realOf = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};
/** A file's place with its folder's links followed (as far as the folders exist), so two spellings of one folder meet. */
const placeOf = (path: string) => {
  const p = resolve(path);
  const base = existingParent(dirname(p));
  return join(realOf(base), relative(base, p));
};

/** What is downloading any of these model files now, if anything. */
export function downloadingBy(paths: string[]): Downloader | null {
  for (const p of paths) {
    const by = writing.get(placeOf(p));
    if (by) return by;
  }
  return null;
}

/** A Hugging Face commit id. */
const REVISION = /^[0-9a-f]{40}$/;

/**
 * Where the commit a model's download is pinned to is kept while any of its files isn't finished: next to its first
 * file. Every part of it, and every later attempt, downloads that one version, so a .part is never continued with the
 * bytes of a file that was uploaded again meanwhile.
 */
export const revisionFile = (model: PoolModel, root = modelsDir()) => `${modelPath(model, root)}.rev`;

function savedRevision(model: PoolModel, root: string): string | null {
  try {
    const rev = readFileSync(revisionFile(model, root), "utf8").trim();
    return REVISION.test(rev) ? rev : null;
  } catch {
    return null;
  }
}

/** The repo's newest commit, which a new download is pinned to. */
async function repoRevision(repo: string, token: string | null | undefined, signal?: AbortSignal): Promise<string> {
  const { res } = await hfFetch(`${hfBase()}/api/models/${repo}`, token, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
  if (!res.ok) throw repoError(res, repo, token);
  const info = (await res.json().catch(() => null)) as { sha?: unknown } | null;
  if (typeof info?.sha !== "string" || !REVISION.test(info.sha)) throw new HttpError(502, "Hugging Face didn't say which version of the model to download: try again in a few minutes.");
  return info.sha;
}

/**
 * Downloads a model's files to ~/.crosstalk/models/<owner>/<repo>/ (or `root`/<owner>/<repo>/), each through a .part
 * file that a later download continues (HTTP Range), all of them from the one commit the download is pinned to. The
 * token goes to Hugging Face only when given. Refused when the disk would be left with less than the hub's reserve, and
 * while any of its files is being downloaded already (by the pool, or by Settings → Local models: `by` says which this
 * is); progress at most twice a second. Resolves to the model's first file.
 */
export async function download(model: PoolModel, token: string | null | undefined, onProgress: (p: DownloadProgress) => void, signal?: AbortSignal, root = modelsDir(), by: Downloader = "pool"): Promise<string> {
  const m = checkModel(model);
  checkSpace(m, root);
  const paths = modelFiles(m, root);
  if (paths.every((p) => sizeOf(p) !== null)) {
    rmSync(revisionFile(m, root), { force: true });
    return paths[0];
  }
  // Taken before the first wait, so no other download of these files can begin in between.
  const busy = downloadingBy(paths);
  if (busy) throw new HttpError(409, DOWNLOADERS[busy], "busy");
  const places = paths.map(placeOf);
  for (const p of places) writing.set(p, by);
  try {
    return await downloadPinned(m, paths, token, onProgress, signal, root);
  } finally {
    for (const p of places) writing.delete(p);
  }
}

async function downloadPinned(m: PoolModel, paths: string[], token: string | null | undefined, onProgress: (p: DownloadProgress) => void, signal: AbortSignal | undefined, root: string): Promise<string> {
  ownFolder(dirname(paths[0]), root);
  let rev = savedRevision(m, root);
  if (!rev) {
    rev = await repoRevision(m.repo, token, signal);
    writeFileSync(revisionFile(m, root), `${rev}\n`);
  }
  try {
    await downloadFiles(m, paths, rev, token, onProgress, signal, root);
  } catch (e) {
    // The version it was pinned to is gone (the repo's history was rewritten): a model with nothing finished yet
    // starts again from the newest one; one with finished parts can't mix versions.
    if (!(e instanceof HttpError && e.code === "revision_gone")) throw e;
    if (paths.some((p) => sizeOf(p) !== null)) {
      throw new HttpError(409, `${m.repo} changed on Hugging Face since its download began: remove the download (Model pool → Advanced → Remove download), then start again.`, "revision_gone");
    }
    for (const p of paths) rmSync(`${p}.part`, { force: true });
    rev = await repoRevision(m.repo, token, signal);
    writeFileSync(revisionFile(m, root), `${rev}\n`);
    await downloadFiles(m, paths, rev, token, onProgress, signal, root);
  }
  rmSync(revisionFile(m, root), { force: true });
  return paths[0];
}

/** The folder is inside the models folder (`root`), also after following links: made if it's missing. */
function ownFolder(dir: string, root: string) {
  mkdirSync(dir, { recursive: true });
  if (!inside(realpathSync(dir), realpathSync(root))) throw new HttpError(400, "The model's folder isn't inside Crosstalk's models folder: remove what's in its way and try again.");
}

async function downloadFiles(m: PoolModel, paths: string[], rev: string, token: string | null | undefined, onProgress: (p: DownloadProgress) => void, signal: AbortSignal | undefined, root: string): Promise<void> {
  const known = new Map<string, number>();
  let last = 0;
  const samples: [number, number][] = [];
  const report = (file: string, done: number) => {
    const now = Date.now();
    if (now - last < 500) return;
    last = now;
    samples.push([now, done]);
    while (samples.length > 2 && now - samples[0][0] > 5000) samples.shift();
    const [t0, d0] = samples[0];
    const total = Math.max(m.sizeBytes, [...known.values()].reduce((a, b) => a + b, 0), done);
    onProgress({ file, doneBytes: done, totalBytes: total, bytesPerSec: now - t0 >= 400 ? Math.round(((done - d0) * 1000) / (now - t0)) : null });
  };
  let before = 0;
  for (const [i, file] of m.files.entries()) {
    const dest = paths[i];
    const have = sizeOf(dest);
    if (have !== null) {
      before += have;
      known.set(file, have);
      continue;
    }
    if (signal?.aborted) throw stopped();
    // A single file's size is the model's; a split model's parts say theirs as they come.
    await fetchFile(m.repo, rev, file, dest, token, m.files.length === 1 ? m.sizeBytes : 0, (done, total) => {
      if (total) known.set(file, total);
      report(file, before + done);
    }, signal, root);
    before += sizeOf(dest) ?? 0;
  }
  log.info(`downloaded ${m.repo} (${m.files.length} file${m.files.length === 1 ? "" : "s"}, ${gb(before)})`);
}

/**
 * Downloads one file of the repo's commit `rev` through its .part (continued with HTTP Range when there is one). The
 * file is only put in place at its full size: from Content-Range, Content-Length, Hugging Face's X-Linked-Size or,
 * failing those, `knownSize`.
 */
async function fetchFile(repo: string, rev: string, file: string, dest: string, token: string | null | undefined, knownSize: number, onBytes: (done: number, total: number) => void, signal: AbortSignal | undefined, root: string, attempt = 0): Promise<void> {
  const dir = dirname(dest);
  ownFolder(dir, root);
  const part = `${dest}.part`;
  let offset = sizeOf(part) ?? 0;
  const url = `${hfBase()}/${repo}/resolve/${rev}/${file.split("/").map(encodeURIComponent).join("/")}`;
  const { res, linkedSize } = await hfFetch(url, token, { headers: offset > 0 ? { range: `bytes=${offset}-` } : {}, signal });
  const restart = async () => {
    await res.body?.cancel().catch(() => {});
    rmSync(part, { force: true });
    if (attempt >= 1) throw new HttpError(502, `Hugging Face sent ${file} in a way Crosstalk can't continue: try again in a few minutes.`);
    return fetchFile(repo, rev, file, dest, token, knownSize, onBytes, signal, root, attempt + 1);
  };
  if (res.status === 416 && offset > 0) {
    // Already all here (or the file changed): Content-Range says the whole size.
    const total = Number(/\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "")?.[1]) || linkedSize;
    if (total === offset) {
      await res.body?.cancel().catch(() => {});
      renameSync(part, dest);
      return;
    }
    return restart();
  }
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => {});
    throw termsError(repo);
  }
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    // Hugging Face says which: the commit is gone (its history was rewritten), or the file isn't in it.
    if (/RevisionNotFound/i.test(res.headers.get("x-error-code") ?? "")) throw new HttpError(404, `The version of ${repo} this download began with is gone from Hugging Face.`, "revision_gone");
    throw new HttpError(404, `${file} isn't on Hugging Face anymore: pick the model again.`);
  }
  if (res.status === 429) throw new HttpError(503, "Hugging Face is limiting downloads from this machine: try again in a few minutes (the download picks up where it stopped).");
  if (!res.ok || !res.body) throw new HttpError(502, `Hugging Face answered ${res.status}: try again in a few minutes (the download picks up where it stopped).`);
  let total: number;
  /** The size came from the server (not only from the model it was asked for). */
  let told = true;
  let append = false;
  if (res.status === 206) {
    const cr = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get("content-range") ?? "");
    if (!cr || Number(cr[1]) !== offset) return restart();
    total = Number(cr[3]);
    append = true;
  } else {
    // The whole file (the server ignored the range): start the .part again.
    const said = Number(res.headers.get("content-length")) || linkedSize || 0;
    told = said > 0;
    total = said || knownSize || 0;
    offset = 0;
  }
  const out = await open(part, append ? "a" : "w");
  let done = offset;
  let checked = Date.now();
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      await out.write(value);
      done += value.length;
      onBytes(done, total);
      // A disk that fills up meanwhile (other downloads, builds) stops it before it's full.
      if (Date.now() - checked > 2000) {
        checked = Date.now();
        if (diskSpace(dir).free < diskReserve()) throw new HttpError(507, `The disk is almost full (keeping ${gb(diskReserve())} free): free up space, then start the download again (it picks up where it stopped).`, "low_disk");
      }
    }
  } catch (e) {
    if (signal?.aborted) throw stopped();
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `The download of ${file} was cut off (${errText(e)}): start it again and it picks up where it stopped.`);
  } finally {
    await out.close();
  }
  if (total && done > total && told) {
    rmSync(part, { force: true });
    throw new HttpError(502, `${file} came out bigger than it is on Hugging Face: start the download again.`);
  }
  if (total && done < total) throw new HttpError(502, `The download of ${file} stopped early: start it again and it picks up where it stopped.`);
  renameSync(part, dest);
}

/**
 * Every model file on this machine as "<owner>/<repo>/<file>" with its size: finished ones, and unfinished downloads
 * (their .part, under the name the file will have). In `root`, the models folder by default.
 */
export function modelFilesOnDisk(root = modelsDir()): PoolModelFile[] {
  const out: PoolModelFile[] = [];
  const dirs = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
    } catch {
      return [];
    }
  };
  const walk = (dir: string, prefix: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory() && depth < 3) walk(join(dir, e.name), `${prefix}${e.name}/`, depth + 1);
      else if (e.isFile() && /\.gguf(\.part)?$/i.test(e.name)) {
        const partial = /\.part$/i.test(e.name);
        out.push({ file: `${prefix}${partial ? e.name.slice(0, -5) : e.name}`, bytes: sizeOf(join(dir, e.name)) ?? 0, partial });
      }
    }
  };
  for (const owner of dirs(root)) for (const repo of dirs(join(root, owner))) walk(join(root, owner, repo), `${owner}/${repo}/`, 0);
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : Number(a.partial) - Number(b.partial)));
}

/**
 * modelFilesOnDisk without holding up the hub while the disk answers (Settings → Local models' folder may be a drive
 * that's waking up, or a network folder that's gone): every look at it is asynchronous.
 */
export async function modelFilesIn(root = modelsDir()): Promise<PoolModelFile[]> {
  const out: PoolModelFile[] = [];
  const entries = (dir: string) => readdir(dir, { withFileTypes: true }).catch(() => []);
  const dirs = async (dir: string) => (await entries(dir)).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    for (const e of await entries(dir)) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory() && depth < 3) await walk(join(dir, e.name), `${prefix}${e.name}/`, depth + 1);
      else if (e.isFile() && /\.gguf(\.part)?$/i.test(e.name)) {
        const partial = /\.part$/i.test(e.name);
        const bytes = await lstat(join(dir, e.name)).then((s) => (s.isFile() ? s.size : 0), () => 0);
        out.push({ file: `${prefix}${partial ? e.name.slice(0, -5) : e.name}`, bytes, partial });
      }
    }
  };
  for (const owner of await dirs(root)) for (const repo of await dirs(join(root, owner))) await walk(join(root, owner, repo), `${owner}/${repo}/`, 0);
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : Number(a.partial) - Number(b.partial)));
}

/** Model files on this machine, as "<owner>/<repo>/<file>" (finished ones only). */
export function modelsOnDisk(): string[] {
  return modelFilesOnDisk()
    .filter((f) => !f.partial)
    .map((f) => f.file);
}

/** "<owner>/<repo>/<file>" (as modelsOnDisk lists it) as the repo and the file, checked. */
export function splitModelFile(entry: unknown): { repo: string; file: string } {
  const parts = typeof entry === "string" ? entry.split("/") : [];
  if (parts.length < 3) throw new HttpError(400, "Pick model files as this machine lists them (owner/repo/file.gguf).");
  return { repo: checkRepo(parts.slice(0, 2).join("/")), file: checkFile(parts.slice(2).join("/")) };
}

export interface TrashOptions {
  /** The home folder whose Trash is used (tests use a temporary one; then gio and XDG_DATA_HOME aren't used). */
  home?: string;
  platform?: NodeJS.Platform;
  /** On Linux, use `gio trash` when it's there (the default for the real home). */
  gio?: boolean;
  /** The device a folder is on (tests pretend a folder is on another drive). */
  deviceOf?: (path: string) => number | null;
}

const deviceOfPath = (path: string): number | null => {
  try {
    return statSync(path).dev;
  } catch {
    return null;
  }
};

/** The folder the drive `path` is on is mounted at: the topmost folder above it on the same device (null when nothing of it exists). */
export function mountPoint(path: string, deviceOf: (p: string) => number | null = deviceOfPath): string | null {
  let p = resolve(path);
  while (deviceOf(p) === null) {
    if (dirname(p) === p) return null;
    p = dirname(p);
  }
  const own = deviceOf(p);
  while (dirname(p) !== p && deviceOf(dirname(p)) === own) p = dirname(p);
  return p;
}

/** The Trash a file can't go in without copying it (it's on another drive, whose own Trash can't be used): deleting is the way out. */
const noTrash = (path: string, mac: boolean) =>
  new HttpError(409, `${basename(path)} is on another drive, and Crosstalk can't use that drive's Trash: delete it for good instead, or delete it in ${mac ? "the Finder" : "the file manager"}.`, "no_trash");

/**
 * Moves files to the Trash, never deleting them outright: on macOS into ~/.Trash under a name that isn't taken there,
 * on Linux with `gio trash` or else into the freedesktop.org Trash (~/.local/share/Trash, with its .trashinfo). A file
 * on another drive goes in that drive's own Trash, as the Finder and file managers do (<drive>/.Trashes/<uid>,
 * <drive>/.Trash-<uid>): moving it into the home's would copy all of it (a model is many GB) onto this machine's disk,
 * with no room kept, and free nothing on the drive until the copy ended. It's never copied: when the drive's Trash
 * can't be used, it stays where it is (409 `no_trash`). Resolves to where each one went (for gio, the Trash folder).
 */
export async function toTrash(paths: string[], opts: TrashOptions = {}): Promise<string[]> {
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const deviceOf = opts.deviceOf ?? deviceOfPath;
  const dataHome = opts.home ? join(opts.home, ".local", "share") : process.env.XDG_DATA_HOME || join(home, ".local", "share");
  // gio only knows the real home's Trash.
  const gio = platform !== "darwin" && opts.gio !== false && !opts.home ? Bun.which("gio") : null;
  const moved: string[] = [];
  for (const path of paths.map((p) => resolve(p))) {
    try {
      lstatSync(path);
    } catch {
      continue; // already gone
    }
    // The folder it's in, links followed: a rename moves it within that folder's disk.
    const dir = realOf(dirname(path));
    if (platform === "darwin") {
      const own = join(home, ".Trash");
      mkdirSync(own, { recursive: true });
      const trash = deviceOf(dir) === deviceOf(own) ? own : finderTrash(path, dir, deviceOf);
      const dest = freeName(trash, basename(path), (stem, n, ext) => `${stem} ${n}${ext}`);
      moveTo(path, dest, true);
      moved.push(dest);
      continue;
    }
    if (gio) {
      // gio puts a file on another drive in that drive's Trash, and fails rather than copy it.
      const p = Bun.spawn([gio, "trash", "--", path], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
      const err = await new Response(p.stderr).text();
      if ((await p.exited) === 0) {
        moved.push(join(dataHome, "Trash", "files", basename(path)));
        continue;
      }
      log.debug(`gio trash failed for ${path}: ${err.trim()}`);
    }
    moved.push(freedesktopTrash(path, dir, dataHome, deviceOf));
  }
  return moved;
}

/** The Finder's Trash on the drive a file is on: <drive>/.Trashes/<uid>, made as the Finder makes it when it's missing. */
function finderTrash(path: string, dir: string, deviceOf: (p: string) => number | null): string {
  const top = mountPoint(dir, deviceOf);
  if (!top || top === "/") throw noTrash(path, true);
  const trashes = join(top, ".Trashes");
  try {
    if (!existsSync(trashes)) {
      mkdirSync(trashes);
      // Anyone may add a folder of their own; no one may list the others'.
      try {
        chmodSync(trashes, 0o1333);
      } catch {
        // A drive without permissions (exFAT): as it is.
      }
    }
    const mine = join(trashes, String(process.getuid?.() ?? 0));
    mkdirSync(mine, { recursive: true, mode: 0o700 });
    return mine;
  } catch (e) {
    log.debug(`no Trash on ${top}: ${errText(e)}`);
    throw noTrash(path, true);
  }
}

/** A name in `dir` that isn't taken: the name itself, else "<stem> 2<ext>", "<stem> 3<ext>"… */
function freeName(dir: string, name: string, numbered: (stem: string, n: number, ext: string) => string): string {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  const taken = (n: string) => {
    try {
      lstatSync(join(dir, n));
      return true;
    } catch {
      return false;
    }
  };
  if (!taken(name)) return join(dir, name);
  for (let n = 2; n < 10_000; n++) if (!taken(numbered(stem, n, ext))) return join(dir, numbered(stem, n, ext));
  return join(dir, `${stem} ${crypto.randomUUID().slice(0, 8)}${ext}`);
}

/** Moves a file into a Trash on its own disk: a rename, never a copy. */
function moveTo(from: string, to: string, mac: boolean) {
  try {
    renameSync(from, to);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // Another disk after all: copying it would fill this one, so it stays.
    if (code === "EXDEV") throw noTrash(from, mac);
    throw new HttpError(500, `Couldn't move ${basename(from)} to the Trash (${code === "EPERM" || code === "EACCES" ? "this machine didn't allow it" : errText(e)}): move it to the Trash yourself.`);
  }
}

/**
 * The freedesktop.org Trash: the .trashinfo (made first, so the name is taken) and the file under files/. A file on
 * another drive goes in that drive's: its shared .Trash/<uid> when an administrator made one (a folder with the sticky
 * bit), else .Trash-<uid>, with the path from the drive's top.
 */
function freedesktopTrash(path: string, dir: string, dataHome: string, deviceOf: (p: string) => number | null): string {
  let trash = join(dataHome, "Trash");
  let original = path;
  if (deviceOf(dir) !== deviceOf(existingParent(trash))) {
    const top = mountPoint(dir, deviceOf);
    if (!top || top === "/") throw noTrash(path, false);
    const uid = String(process.getuid?.() ?? 0);
    trash = join(top, `.Trash-${uid}`);
    try {
      const shared = lstatSync(join(top, ".Trash"));
      if (shared.isDirectory() && shared.mode & 0o1000) trash = join(top, ".Trash", uid);
    } catch {
      // None: the drive's own one for this person.
    }
    original = relative(top, join(dir, basename(path)));
  }
  try {
    mkdirSync(join(trash, "files"), { recursive: true, mode: 0o700 });
    mkdirSync(join(trash, "info"), { recursive: true, mode: 0o700 });
  } catch (e) {
    log.debug(`no Trash at ${trash}: ${errText(e)}`);
    throw noTrash(path, false);
  }
  const encoded = original.split("/").map(encodeURIComponent).join("/");
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  for (let n = 1; n < 10_000; n++) {
    const ext = extname(basename(path));
    const stem = ext ? basename(path).slice(0, -ext.length) : basename(path);
    const name = n === 1 ? basename(path) : `${stem}.${n}${ext}`;
    const info = join(trash, "info", `${name}.trashinfo`);
    if (existsSync(join(trash, "files", name))) continue;
    try {
      writeFileSync(info, `[Trash Info]\nPath=${encoded}\nDeletionDate=${date}\n`, { flag: "wx", mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw new HttpError(500, `Couldn't move ${basename(path)} to the Trash (${errText(e)}): move it there yourself.`);
    }
    try {
      moveTo(path, join(trash, "files", name), false);
    } catch (e) {
      rmSync(info, { force: true });
      throw e;
    }
    return join(trash, "files", name);
  }
  throw new HttpError(500, `Couldn't find a free name for ${basename(path)} in the Trash: empty the Trash, then try again.`);
}
