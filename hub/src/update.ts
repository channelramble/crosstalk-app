// An update that applies itself. A new build of the hub is put in place of the running one (the installer, or a
// deploy); until now it then waited for someone to restart the hub, by hand or with a script that gave up when chats
// never went quiet. Now the hub notices the new build, says so to every device ("Update 0.7.1 is ready"), and restarts
// itself the first time nothing has been working for two minutes. The service that runs it (launchd, systemd) starts
// the new build; replies that were interrupted pick up as after any restart. "Restart now" in the app does it at once.
//
// It never restarts over work by itself: a reply running or waiting, an agent's background work, a question to another
// agent. However long that takes, the update waits, and the app says what it's waiting for.

import type { HubUpdate } from "@crosstalk/shared";
import { logger } from "./util/log";

const log = logger("update");

/** How often the hub looks for a new build at its own path. */
const LOOK_MS = 30_000;
/** How long nothing may have been working before it restarts. */
export const QUIET_MS = 2 * 60_000;

export interface UpdateDeps {
  /** The version of a new build at the hub's own path, or null when it runs what's there (setup/system.ts stagedBuild). */
  staged(): Promise<string | null>;
  /** What's working right now, as chats' names (empty: nothing). */
  working(): string[];
  /** Restarts the hub: shuts down cleanly and exits, for the service to start it again. */
  restart(): void;
  /** Tells every device (the hub's info carries the update). */
  changed(): void;
  now?(): number;
}

export class Updater {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ready: { version: string; since: number } | null = null;
  private quietSince: number | null = null;
  private lastSaid = "";
  private restarting = false;

  constructor(private deps: UpdateDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  start() {
    this.timer = setInterval(() => void this.look().catch(() => {}), LOOK_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** What every device is told: the version waiting, and what it waits for. Null when the hub runs the newest build here. */
  status(): HubUpdate | null {
    if (!this.ready) return null;
    const working = this.deps.working();
    return { version: this.ready.version, since: this.ready.since, working: working.length, chats: working.slice(0, 3), restarting: this.restarting };
  }

  /** One look: is a new build there, and is it quiet enough to start it. Called on a timer, and by tests. */
  async look(): Promise<void> {
    if (this.restarting) return;
    const version = await this.deps.staged();
    if (!version) {
      if (this.ready) {
        // Put back as it was (a deploy undone): nothing to restart for.
        this.ready = null;
        this.quietSince = null;
        this.say();
      }
      return;
    }
    if (this.ready?.version !== version) {
      this.ready = { version, since: this.now() };
      this.quietSince = null;
      log.info(`a new build is in place: ${version}. Restarting when nothing has been working for ${QUIET_MS / 60_000} minutes.`);
    }
    const working = this.deps.working();
    if (working.length) this.quietSince = null;
    else this.quietSince ??= this.now();
    this.say();
    if (this.quietSince !== null && this.now() - this.quietSince >= QUIET_MS) this.go("nothing has been working");
  }

  /** "Restart now", from the app. False when there's no update to restart for. */
  restartNow(by: string): boolean {
    if (!this.ready || this.restarting) return !!this.ready;
    const working = this.deps.working();
    this.go(`${by} asked${working.length ? `, stopping work in ${working.join(", ")}` : ""}`);
    return true;
  }

  private go(why: string) {
    this.restarting = true;
    log.info(`restarting onto ${this.ready?.version}: ${why}`);
    this.deps.changed();
    this.deps.restart();
  }

  /** Devices hear only when what they show would change. */
  private say() {
    const s = this.status();
    const said = s ? `${s.version}|${s.working}|${s.chats.join(",")}` : "";
    if (said === this.lastSaid) return;
    this.lastSaid = said;
    this.deps.changed();
  }
}
