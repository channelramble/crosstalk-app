import type { FitKind, LocalDownload, LocalFolder, LocalMachine, LocalModelFile, LocalStarted } from "@crosstalk/shared";
import { bytesText, capacity, fitOf, needOf } from "@crosstalk/shared";
import { contextLabel, downloadText, fileName, modelName, parseHfLink } from "./pool";

// Settings → Local models, getting models and starting servers (views/LocalModelsGet.tsx, LocalModelsLibrary.tsx): the
// suggested file, room on the disk and the words for downloads and servers, as pure functions so they can be tested.
// The "fits this machine?" verdict itself lives in shared (`needOf`, `capacity`, `fitOf`), because the hub's memory
// guard asks it the same question before it starts a server, and two opinions would be one too many.

export { capacity, FALLBACK_KV, fitOf, needOf, OVERHEAD, ramRoom, roomFor, TIGHT } from "@crosstalk/shared";
export type { Fit, FitKind, Need } from "@crosstalk/shared";

/** The contexts offered (tokens): Claude Code needs about 20k just to start. */
export const CONTEXTS = [32768, 65536, 131072];
export const DEFAULT_CONTEXT = 32768;

/** The machine in a sentence, above the files: its memory and what models can use of it. */
export function machineText(m: LocalMachine, machine: string): string {
  const mem = bytesText(m.ramBytes);
  if (m.unified) return `${machine} has ${mem} of memory, shared with its GPU: models can use ${m.gpuFrom === "estimate" ? "about " : ""}${bytesText(capacity(m).bytes)} of it.`;
  if ((m.gpuBytes ?? 0) > 0) {
    const gpus = m.gpus.filter((g) => g.totalBytes > 0);
    const its = gpus.length === 1 ? `its ${gpus[0].name} has` : `its ${gpus.length} GPUs have`;
    return `${machine} has ${mem} of memory, and ${its} ${bytesText(m.gpuBytes!)} free.`;
  }
  return `${machine} has ${mem} of memory and no GPU llama.cpp found: models run on the processor.`;
}

/** Quants that keep most of a model's quality, best first: the suggestion is the biggest of these that fits. */
const KEEPS_QUALITY = /^(UD-)?(Q8_0|Q6_K(_XL)?|Q5_K_(M|XL)|Q4_K_(M|XL))$/i;

/** Below 4 bits a model loses noticeably more (said beside those files). */
export const lowQuality = (quant: string | null) => !!quant && /^(UD-)?(IQ[1-3]|Q[23]_|TQ[12]_)/i.test(quant);

/** The file to suggest of a repo's: the biggest of Q8_0, Q6_K, Q5_K_M, Q4_K_M that fits, else the biggest that fits; null when none does. */
export function suggestedFile<T extends { files: string[]; quant: string | null; sizeBytes: number }>(models: T[], fit: (m: T) => FitKind): string | null {
  const fits = models.filter((m) => fit(m) === "fits");
  const biggest = (list: T[]) => [...list].sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
  return (biggest(fits.filter((m) => !!m.quant && KEEPS_QUALITY.test(m.quant))) ?? biggest(fits))?.files[0] ?? null;
}

/**
 * The model llama.cpp starts with unless one is picked: the biggest here that fits at the usual context, else the
 * biggest that's tight, else the smallest (the least too big: the biggest would leave the machine swapping hardest).
 */
export function startChoice(files: LocalModelFile[], m: LocalMachine): string | null {
  const biggestFirst = [...files].sort((a, b) => b.bytes - a.bytes);
  const kind = (f: LocalModelFile) => fitOf(needOf(f.bytes, f.kvBytesPerToken, DEFAULT_CONTEXT, f.contextLength).bytes, m, "").kind;
  const pick = biggestFirst.find((f) => kind(f) === "fits") ?? biggestFirst.find((f) => kind(f) === "tight") ?? biggestFirst.at(-1);
  return pick?.id ?? null;
}

/** Why a download of `remaining` bytes can't go in the folder now (its problem, or not enough room past the reserve); null when it can. */
export function roomProblem(remaining: number, folder: LocalFolder, reserveBytes: number): string | null {
  if (folder.problem) return folder.problem;
  if (folder.freeBytes === null || folder.freeBytes - reserveBytes >= remaining) return null;
  const room = folder.freeBytes - reserveBytes;
  return `Not enough room in ${folder.shown}: it needs ${bytesText(remaining)} and ${room > 0 ? `${bytesText(room)} is` : "nothing is"} free (keeping ${bytesText(reserveBytes)} free). Free up space, or change the folder.`;
}

/** "~/.crosstalk/models · 120 GB free", and the drive when it's on one. */
export function folderLine(f: LocalFolder): string {
  const free = f.freeBytes !== null ? ` · ${bytesText(f.freeBytes)} free` : "";
  return `${f.shown}${f.drive ? ` (on ${f.drive})` : ""}${free}`;
}

/** Ollama's own words for what a pull is doing, in plain ones. */
const STEPS: Record<string, string> = { "pulling manifest": "Looking it up…", "verifying sha256 digest": "Checking it…", "writing manifest": "Finishing…", "Starting…": "Starting…" };

/** Under a download's name: its progress, where it stopped, or what went wrong. */
export function downloadLine(d: LocalDownload): string {
  if (d.state === "failed") return d.error ?? "It stopped.";
  const pct = d.totalBytes > 0 ? Math.min(100, Math.floor((d.doneBytes / d.totalBytes) * 100)) : null;
  if (d.state === "stopped") return pct !== null ? `Stopped at ${pct}% · ${bytesText(d.doneBytes)} of ${bytesText(d.totalBytes)}` : "Stopped";
  if (d.step && STEPS[d.step]) return STEPS[d.step];
  if (d.totalBytes <= 0) return "Starting…";
  return downloadText({ file: "", doneBytes: d.doneBytes, totalBytes: d.totalBytes, bytesPerSec: d.bytesPerSec });
}

/** How far a download is, for its bar (0 to 100). */
export const downloadPct = (d: Pick<LocalDownload, "doneBytes" | "totalBytes">) => (d.totalBytes > 0 ? Math.min(100, (d.doneBytes / d.totalBytes) * 100) : 0);

/** The way out a failed download's code points to. */
export function downloadWayOut(d: Pick<LocalDownload, "code" | "source">): "folder" | "token" | null {
  if (d.code === "low_disk" || d.code === "folder") return d.source === "huggingface" ? "folder" : null;
  if (d.code === "hf_terms") return "token";
  return null;
}

/** "llama.cpp on port 8080". */
export const startedTitle = (s: Pick<LocalStarted, "kind" | "port">) => `${s.kind === "ollama" ? "Ollama" : "llama.cpp"} on port ${s.port}`;

/** Under a server Crosstalk started: what it's doing, or what went wrong. */
export function startedLine(s: LocalStarted): string {
  if (s.state === "starting") return s.detail ?? "Starting…";
  if (s.state === "stopping") return "Stopping…";
  if (s.state === "failed") return s.detail ?? "It stopped.";
  return s.detail ?? "Running";
}

/** A downloaded model as people read it: "Qwen3-8B · Q4_K_M". */
export const fileTitle = (f: Pick<LocalModelFile, "repo" | "quant" | "files">) => `${modelName(f.repo)} · ${f.quant ?? fileName(f.files[0])}`;

/** What the person typed in the search box: a Hugging Face repo (a link or owner/name) to open, or words to search for. */
export function lookFor(input: string): { repo: string } | { q: string } | null {
  const s = input.trim();
  if (!s) return null;
  const link = parseHfLink(s);
  if (link) return { repo: link.repo };
  return s.length >= 2 ? { q: s } : null;
}

/** "8.2B", "30.5B", "235B", "600M" parameters. */
export function paramsText(n: number | null): string | null {
  if (!n || n <= 0) return null;
  if (n >= 100e9) return `${Math.round(n / 1e9)}B`;
  if (n >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
  return `${Math.round(n / 1e6)}M`;
}

/** "12k downloads", "1.2M downloads". */
export function downloadsText(n: number): string {
  const short = n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n);
  return `${short} download${n === 1 ? "" : "s"}`;
}

/** Ollama's names: "qwen3:8b", "user/model:tag", "hf.co/owner/repo:Q4_K_M" (as the hub takes them). */
export function ollamaNameProblem(name: string): string | null {
  const s = name.trim();
  return /^(?!.*\.\.)[A-Za-z0-9][\w.\-/:]{0,199}$/.test(s) ? null : "Type a model's name as Ollama's library writes it, like qwen3:8b.";
}

/** The contexts to offer for a model trained for `contextLength` tokens: those it holds, or only its own when that's less than 32k (what llama.cpp is started with then). */
export function contextsFor(contextLength: number | null): number[] {
  const fit = CONTEXTS.filter((c) => !contextLength || c <= contextLength);
  return fit.length ? fit : [contextLength!];
}

/** "32k context" */
export const contextText = (n: number) => `${contextLabel(n)} context`;
