// Export as Markdown (docs/SPEC-0.4.md section 14, track T8): fetches the chat's file from its hub with this device's
// sign-in, and hands it to the share sheet when the browser can share files, else saves it as a download.

import { markdownFileName } from "@crosstalk/shared";
import { ApiError, currentConnection, type Connection } from "./api";

/** "shared": the share sheet took it. "saved": the browser downloaded it. "cancelled": the share sheet was closed. */
export type Exported = "shared" | "saved" | "cancelled";

/** What went wrong, from the hub's answer, in words that say what to do. */
export function exportProblem(status: number, hubSaid: string): string {
  // A hub from before Markdown export answers any route it doesn't know with "not found".
  if (status === 404 && /^not found$/i.test(hubSaid.trim())) return "This machine runs an older Crosstalk that can't export yet. Update it, then try again.";
  if (status === 404) return "That chat isn't on its machine any more.";
  if (status === 401) return "The machine signed this device out. Pair it again in Settings → Machines.";
  return hubSaid.trim() || `The machine answered with an error (${status}).`;
}

/** Whether this browser can hand a file to the share sheet (phones can; most desktop browsers can't). */
export function canShareFile(file: File): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function" && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
}

/**
 * The file to hand to the share sheet: as Markdown, or, where the sheet takes only a few kinds of text (phones' often do),
 * the same text as plain text under the same name. Null: this browser can't share files.
 */
function shareable(text: string, name: string): File | null {
  for (const type of ["text/markdown", "text/plain"]) {
    const file = new File([text], name, { type });
    if (canShareFile(file)) return file;
  }
  return null;
}

/** Saves a file through the browser's own download. */
function download(file: File) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** The chat as a Markdown file: shared or saved. Throws an ApiError with a sentence that says what to do. */
export async function exportMarkdown(room: { id: string; name: string }, c: Connection | null = currentConnection()): Promise<Exported> {
  const ctl = new AbortController();
  // A long chat from a slow machine can take a while: a minute.
  const timer = setTimeout(() => ctl.abort(), 60_000);
  let text: string;
  try {
    const res = await fetch(`${c?.baseUrl ?? ""}/api/chats/${encodeURIComponent(room.id)}/export.md`, { headers: c?.token ? { authorization: `Bearer ${c.token}` } : {}, signal: ctl.signal });
    if (!res.ok) throw new ApiError(res.status, exportProblem(res.status, await res.json().then((j: { error?: string }) => j?.error ?? "", () => "")));
    text = await res.text();
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, ctl.signal.aborted ? "The machine didn't answer in time. Check that it's running, then try again." : "Can't reach the machine. Check that it's running and that this device is on your Tailscale network.");
  } finally {
    clearTimeout(timer);
  }
  const name = markdownFileName(room.name);
  const toShare = shareable(text, name);
  if (toShare) {
    try {
      await navigator.share({ files: [toShare], title: room.name });
      return "shared";
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return "cancelled";
      // The browser wouldn't share it (the tap that started this is too long ago, say): it's saved instead.
    }
  }
  download(new File([text], name, { type: "text/markdown" }));
  return "saved";
}
