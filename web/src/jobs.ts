/** Background attachment uploads, and the attachments themselves, per chat: see AttachmentDesk. */
import type { PendingFile, PendingFolder } from "./folders";

export type Phase = "packing" | "uploading" | "unpacking" | "done" | "error";
export type Job = { phase: Phase; done: number; total: number; error?: string; result?: string; promise: Promise<void>; abort: () => void };

/**
 * Tracks each attachment's upload. Once disposed (its chat's desk let go, because nothing is waiting there any more)
 * it cancels everything and refuses new work, so a folder that finishes reading afterwards can't start an upload.
 */
export class UploadJobs {
  private jobs = new Map<string, Job>();
  private disposed = false;

  constructor(private onChange: (force: boolean) => void) {}

  get alive(): boolean {
    return !this.disposed;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Starts (or restarts) the upload for `id`. Returns undefined, doing nothing, once disposed. */
  run(id: string, work: (job: Job, signal: AbortSignal) => Promise<string>): Job | undefined {
    if (this.disposed) return undefined;
    this.jobs.get(id)?.abort();
    const ctl = new AbortController();
    const job: Job = { phase: "uploading", done: 0, total: 0, promise: Promise.resolve(), abort: () => ctl.abort() };
    job.promise = work(job, ctl.signal).then(
      (result) => { if (ctl.signal.aborted) return; job.result = result; job.phase = "done"; this.onChange(true); },
      (e) => { if (ctl.signal.aborted) return; job.phase = "error"; job.error = e instanceof Error ? e.message : String(e); this.onChange(true); },
    );
    this.jobs.set(id, job);
    this.onChange(true);
    return job;
  }

  remove(id: string): void {
    this.jobs.get(id)?.abort();
    this.jobs.delete(id);
  }

  /** Forgets finished jobs after a send. */
  clear(): void {
    this.jobs.clear();
  }

  dispose(): void {
    this.disposed = true;
    for (const j of this.jobs.values()) j.abort();
    this.jobs.clear();
  }
}

/**
 * The attachments one chat is waiting to send, and their uploads, kept outside the message box's own life. Looking at
 * another chat unmounts the box (ChatScreen keys it by room), and a file attached here — or a folder still going up —
 * has to survive that trip the way the typed draft does: dropping it took minutes of upload with it and said nothing.
 * One desk per chat; it is let go once it holds nothing (the message was sent, or the attachments were taken off).
 */
export class AttachmentDesk {
  files: PendingFile[] = [];
  folders: PendingFolder[] = [];
  readonly jobs: UploadJobs;
  /** The message box on screen for this chat, while there is one: what to repaint as an upload moves. */
  notify: ((force: boolean) => void) | null = null;

  constructor() {
    this.jobs = new UploadJobs((force) => this.notify?.(force));
  }

  get empty(): boolean {
    return !this.files.length && !this.folders.length;
  }

  /** Lets everything go: uploads cancelled, previews freed. Only for a desk that holds nothing. */
  close(): void {
    for (const f of this.files) if (f.preview) URL.revokeObjectURL(f.preview);
    this.files = [];
    this.folders = [];
    this.jobs.dispose();
  }
}

const desks = new Map<string, AttachmentDesk>();

export const deskFor = (roomId: string): AttachmentDesk => {
  const desk = desks.get(roomId);
  if (desk?.jobs.alive) return desk;
  const made = new AttachmentDesk();
  desks.set(roomId, made);
  return made;
};

/** Every chat's waiting attachments: what a reload would lose, which the update banner asks about first. */
export const waitingAttachments = (): number => {
  let n = 0;
  for (const desk of desks.values()) n += desk.files.length + desk.folders.length;
  return n;
};

/** Nothing waiting in this chat: let its desk go. Anything waiting stays, and its uploads carry on. */
export const dropEmptyDesk = (roomId: string): void => {
  const desk = desks.get(roomId);
  if (!desk?.empty) return;
  desk.close();
  desks.delete(roomId);
};
