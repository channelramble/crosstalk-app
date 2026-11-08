// RUN_DIR/busy.json: what the hub is busy with that its database doesn't show, for the scripts that restart it only when
// nothing would be lost (deploy/restart-when-idle.sh, deploy/restart-when-turns-end.sh). Those read the database for
// replies and asks, and Claude Code's transcripts for its own activity, but an agent's background work (a 30-minute test
// suite Claude Code started in the background writes to its own output file, not the transcript) and a wake-up its
// process owes (a helper's report, about to be answered) live only in the hub's memory and the agent's process: a restart
// under them ended the job and lost the continuation. The hub keeps this file current (Engine.busyWork) and rewrites it
// every minute, so a file that hasn't changed for three is from a hub that isn't running, and the scripts ignore it. It
// goes when the hub stops.

import { renameSync, rmSync, writeFileSync } from "node:fs";
import type { ServerEvent } from "@crosstalk/shared";
import { logger } from "./util/log";

const log = logger("busy");

/** How often the file is rewritten when nothing changed: the scripts take one older than three minutes for a stopped hub. */
export const BUSY_BEAT_MS = 60_000;
/** Changes are written this long after they come, so a burst of events is one write. */
const SETTLE_MS = 500;

export interface BusyEntry {
  roomId: string;
  memberId: string;
  why: "background" | "owed";
}

/** What busy.json holds: `count` first, so a shell script can read it with sed. */
export interface BusyFileBody {
  count: number;
  pid: number;
  at: number;
  busy: BusyEntry[];
}

export class BusyFile {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  private off: (() => void) | null = null;
  private last = "";

  /**
   * `path`: where it goes (null: a hub that keeps nothing on disk, which writes nothing). `read`: what's busy now.
   * `on`: the hub's events; what changes the answer comes with a "tasks", "turn" or "member" event.
   */
  constructor(
    private readonly path: string | null,
    private readonly read: () => BusyEntry[],
    on: (listener: (e: ServerEvent) => void) => () => void,
    private readonly beatMs = BUSY_BEAT_MS,
  ) {
    if (!path) return;
    this.off = on((e) => {
      if (e.t === "tasks" || e.t === "turn" || e.t === "member") this.soon();
    });
    this.beat = setInterval(() => this.write(true), beatMs);
    (this.beat as { unref?: () => void }).unref?.();
    this.write(true);
  }

  private soon() {
    if (this.timer || !this.path) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write(false);
    }, SETTLE_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Writes it whole, then moves it into place (a script never reads half of it). `always`: even when nothing changed. */
  write(always: boolean) {
    if (!this.path) return;
    let busy: BusyEntry[];
    try {
      busy = this.read();
    } catch (e) {
      log.debug(`couldn't say what's busy: ${e instanceof Error ? e.message : e}`);
      return;
    }
    const key = JSON.stringify(busy);
    if (!always && key === this.last) return;
    this.last = key;
    const body: BusyFileBody = { count: busy.length, pid: process.pid, at: Date.now(), busy };
    try {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(body) + "\n", { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (e) {
      log.warn(`couldn't write ${this.path}: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** The hub is stopping: nothing more is written, and the file goes (a stopped hub is busy with nothing). */
  stop() {
    if (this.timer) clearTimeout(this.timer);
    if (this.beat) clearInterval(this.beat);
    this.timer = this.beat = null;
    this.off?.();
    this.off = null;
    if (this.path) rmSync(this.path, { force: true });
  }
}
