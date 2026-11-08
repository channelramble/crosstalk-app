import type { Provider, PtyInfo } from "@crosstalk/shared";
import type { Bus } from "./bus";
import { newId } from "./util/ids";
import { logger } from "./util/log";

const log = logger("pty");
const SCROLLBACK = 256 * 1024;

interface Session {
  info: PtyInfo;
  proc: ReturnType<typeof Bun.spawn> | null;
  term: InstanceType<typeof Bun.Terminal>;
  buffer: string;
  listeners: Set<(chunk: string, all: string) => void>;
  exitWaiters: ((code: number | null) => void)[];
}

export interface SpawnOptions {
  title: string;
  /** The command as a person would type it, when `argv` wraps it (shown instead of argv). */
  command?: string;
  purpose: PtyInfo["purpose"];
  provider?: Provider | null;
  cwd?: string;
  env?: Record<string, string | undefined>;
  cols?: number;
  rows?: number;
}

/** Real terminals (via Bun.Terminal) streamed to clients for sign-ins, installs and admin shells. */
export class PtyManager {
  private sessions = new Map<string, Session>();

  constructor(private bus: Bus) {}

  spawn(argv: string[], opts: SpawnOptions): PtyInfo {
    const id = newId("pty");
    const decoder = new TextDecoder();
    const info: PtyInfo = {
      id,
      title: opts.title,
      command: opts.command ?? argv.join(" "),
      purpose: opts.purpose,
      provider: opts.provider ?? null,
      alive: true,
      exitCode: null,
      createdAt: Date.now(),
    };
    const session: Session = {
      info,
      proc: null,
      term: null as unknown as InstanceType<typeof Bun.Terminal>,
      buffer: "",
      listeners: new Set(),
      exitWaiters: [],
    };
    session.term = new Bun.Terminal({
      cols: opts.cols ?? 100,
      rows: opts.rows ?? 30,
      name: "xterm-256color",
      data: (_t, bytes) => {
        const chunk = decoder.decode(bytes, { stream: true });
        session.buffer = (session.buffer + chunk).slice(-SCROLLBACK);
        this.bus.emit({ t: "pty.data", ptyId: id, data: chunk });
        for (const fn of session.listeners) fn(chunk, session.buffer);
      },
    });
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", ...opts.env })) {
      if (v !== undefined) env[k] = v;
    }
    try {
      session.proc = Bun.spawn(argv, { terminal: session.term, cwd: opts.cwd, env });
    } catch (e) {
      session.term.close();
      throw new Error(`Couldn't start ${argv[0]}: ${e instanceof Error ? e.message : e}`);
    }
    this.sessions.set(id, session);
    this.bus.emit({ t: "pty", pty: info });
    void session.proc.exited.then((code) => {
      info.alive = false;
      info.exitCode = code;
      this.bus.emit({ t: "pty", pty: { ...info } });
      for (const w of session.exitWaiters) w(code);
      session.exitWaiters = [];
      setTimeout(() => session.term.close(), 250);
      log.debug(`${info.command} exited ${code}`);
    });
    return { ...info };
  }

  list(): PtyInfo[] {
    return [...this.sessions.values()].map((s) => ({ ...s.info }));
  }

  get(id: string): PtyInfo | null {
    const s = this.sessions.get(id);
    return s ? { ...s.info } : null;
  }

  scrollback(id: string): string {
    return this.sessions.get(id)?.buffer ?? "";
  }

  write(id: string, data: string) {
    const s = this.sessions.get(id);
    if (s && s.info.alive) s.term.write(data);
  }

  resize(id: string, cols: number, rows: number) {
    const s = this.sessions.get(id);
    if (s && s.info.alive && cols > 1 && rows > 1) s.term.resize(Math.min(cols, 500), Math.min(rows, 200));
  }

  onData(id: string, fn: (chunk: string, all: string) => void): () => void {
    const s = this.sessions.get(id);
    if (!s) return () => {};
    s.listeners.add(fn);
    return () => s.listeners.delete(fn);
  }

  waitExit(id: string): Promise<number | null> {
    const s = this.sessions.get(id);
    if (!s) return Promise.resolve(null);
    if (!s.info.alive) return Promise.resolve(s.info.exitCode);
    return new Promise((res) => s.exitWaiters.push(res));
  }

  kill(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.info.alive) s.proc?.kill();
    this.sessions.delete(id);
  }

  /** Remove finished sessions older than a few minutes. */
  sweep() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, s] of this.sessions) if (!s.info.alive && s.info.createdAt < cutoff) this.sessions.delete(id);
  }

  killAll() {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }
}
