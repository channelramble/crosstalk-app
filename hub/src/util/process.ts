import { logger } from "./log";

const log = logger("process");

/** How long a process gets to exit after SIGTERM before SIGKILL. */
export const processGrace = { ms: 3000 };

/** Every process still being ended, including ones a driver has already let go of (retired, or dropped by the watchdog). */
const ending = new Set<Promise<void>>();

/** Resolves once every process being ended has exited: a hub shutting down waits for this, so none is left orphaned. */
export async function processesEnding(): Promise<void> {
  while (ending.size) await Promise.all([...ending]);
}

/**
 * Ends a process group (a command started on its own, with whatever it started): SIGTERM, then SIGKILL to what's left after
 * the grace period. Tracked like endProcess, because the shell can die at once and leave something that ignored the first
 * signal running with nobody to end it, and a hub shutting down waits for this.
 */
export function endGroup(pid: number): void {
  const signal = (sig: NodeJS.Signals | 0) => {
    try {
      process.kill(-pid, sig);
      return true;
    } catch {
      return false;
    }
  };
  signal("SIGTERM");
  const done = (async () => {
    for (const until = Date.now() + processGrace.ms; Date.now() < until; await Bun.sleep(50)) if (!signal(0)) return;
    signal("SIGKILL");
  })();
  ending.add(done);
  void done.finally(() => ending.delete(done));
}

type Proc = {
  pid: number;
  exitCode: number | null;
  signalCode?: string | null;
  exited?: Promise<unknown>;
  kill(signal?: NodeJS.Signals | number): void;
};

/**
 * Ends an agent's process: SIGTERM, then SIGKILL if it's still there after the grace period. A frozen agent CLI can
 * ignore SIGINT and SIGTERM (seen with Claude Code), and Crosstalk must never keep talking to one. Resolves once the
 * process has exited, so a hub shutting down can wait for it instead of leaving it running orphaned.
 */
export function endProcess(proc: Proc): Promise<void> {
  const gone = () => proc.exitCode !== null || (proc.signalCode ?? null) !== null;
  if (gone()) return Promise.resolve();
  try {
    proc.kill("SIGTERM");
  } catch {
    return Promise.resolve();
  }
  const done = new Promise<void>((resolve) => {
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const kill = setTimeout(() => {
      if (!gone()) {
        log.info(`process ${proc.pid} didn't stop; killing it`);
        try {
          proc.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
      giveUp = setTimeout(finish, 1000); // SIGKILL can't be ignored; don't wait on `exited` forever regardless
    }, processGrace.ms);
    function finish() {
      clearTimeout(kill);
      clearTimeout(giveUp);
      resolve();
    }
    void proc.exited?.then(finish, finish);
  });
  ending.add(done);
  void done.finally(() => ending.delete(done));
  return done;
}
