// The hub machine's screen: seen live from the phone, and driven by the agents (docs/SCREEN.md).
//
// Everything goes through the machine's own screen sharing on 127.0.0.1 (macOS's Screen Sharing; any VNC server on
// Linux). That is deliberate: its input is a person's as far as the system is concerned, so a click from here answers
// the dialogs that ignore software clicks, and the hub needs no screen-recording or accessibility permission of its own.
// What it costs is one step at the machine: turning screen sharing on and giving Crosstalk its password (kept in the
// hub's secrets file, never sent to a device).
//
//   - the phone's view: a WebSocket the hub signs in for and then passes through (attachViewer; web's ScreenPage draws it)
//   - the agents' tools: one connection the hub keeps a copy of the screen from (screenshot, click, type, key, scroll, drag)
//   - the windows on screen, so the view can go to the one an agent is using

import { settingsPath } from "@crosstalk/shared";
import { platform as osPlatform, userInfo } from "node:os";
import type { ScreenStatus, ScreenWindow } from "@crosstalk/shared";
import { HttpError } from "../engine/engine";
import { logger } from "../util/log";
import { encodePng, scaleRgb } from "./image";
import { keysymOf, needsShift, parseCombo } from "./keys";
import { BUTTON, RfbClient, RfbError, rfbOpen, type RfbConnection, type RfbCredentials } from "./rfb";

const log = logger("screen");
/** The widest picture an agent is given: coordinates in its tools are this picture's. */
const AGENT_WIDTH = 1280;
/** The agents' connection is let go after this long unused. */
const IDLE_MS = 3 * 60_000;

export interface ScreenSettings {
  /** Agents may look at and drive the screen. Off until the person turns it on. */
  agents: boolean;
  /** A Mac account to sign in to Screen Sharing with, when it isn't set to take a VNC password. Empty: a VNC password. */
  username: string;
}
export const FACTORY_SCREEN: ScreenSettings = { agents: false, username: "" };

interface Deps {
  settings(): ScreenSettings;
  save(next: ScreenSettings): void;
  /** The screen sharing password, from the hub's secrets file ("" when none); and keeping a new one (null: none). */
  password(): string;
  setPassword(p: string | null): void;
  /** Tells the app (the hub's info carries whether the screen can be seen). */
  changed(): void;
  /** The pids of this hub's own agents' processes and what they started, for telling an agent's windows from the rest. */
  hubPid: number;
  host?: string;
  port?: number;
  /** For tests: the windows, instead of asking the system. */
  windows?: () => Promise<ScreenWindow[]>;
  /**
   * For tests: whether macOS started a login screen of its own since `since` (ms), instead of asking the system; and
   * this Mac's accounts (short name and full name), instead of asking the directory.
   */
  ownLoginScreen?: (since: number) => Promise<boolean>;
  accounts?: () => Promise<MacAccount[]>;
}

export interface MacAccount {
  name: string;
  fullName: string;
}

/** How long a screen that answers is trusted before it's looked at again with nobody watching. */
const RECHECK_MS = 30 * 60_000;

export class ScreenManager {
  private agent: RfbClient | null = null;
  private opening: Promise<RfbClient> | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private viewers = new Set<RfbConnection>();
  /** The last time signing in was tried, and how it went: what Settings says without trying again on every look. */
  private last: { ok: boolean; problem: string | null; code: RfbError["code"] | null; width: number; height: number; separate?: boolean; at?: number } | null = null;
  /** One action at a time: two agents typing at once would interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private deps: Deps) {}

  private get host() {
    return this.deps.host ?? process.env.CROSSTALK_SCREEN_HOST ?? "127.0.0.1";
  }
  private get port() {
    return this.deps.port ?? (Number(process.env.CROSSTALK_SCREEN_PORT) || 5900);
  }
  private creds(): RfbCredentials {
    const password = this.deps.password();
    const username = this.deps.settings().username;
    return { ...(password ? { password } : {}), ...(username ? { username } : {}) };
  }

  /** Whether the screen can be seen right now, as far as the last try knows (the hub's info, and the agents' tools). */
  ready(): boolean {
    return !!this.last?.ok;
  }
  /** Agents get the screen's tools: not while what's shown is a login screen macOS made aside (there's nothing of the person's on it). */
  agentsAllowed(): boolean {
    return this.ready() && !this.last?.separate && this.deps.settings().agents;
  }

  status(): ScreenStatus {
    const s = this.deps.settings();
    return {
      platform: osPlatform(),
      hasPassword: !!this.deps.password(),
      username: s.username,
      account: this.isMacScreen() ? userInfo().username : "",
      separate: !!this.last?.ok && !!this.last.separate,
      agents: s.agents,
      ready: !!this.last?.ok,
      state: !this.last ? "unknown" : this.last.ok ? "ready" : this.last.code === "off" ? "off" : this.last.code === "auth" ? "auth" : "problem",
      problem: this.last?.ok ? null : this.last?.problem ?? null,
      width: this.last?.width ?? 0,
      height: this.last?.height ?? 0,
      viewers: this.viewers.size,
    };
  }

  /** Tries to sign in once and says how it went (Settings' Check, and the hub's start). */
  async check(): Promise<ScreenStatus> {
    const before = this.ready();
    const wasSeparate = !!this.last?.separate;
    const started = Date.now();
    try {
      const c = await rfbOpen(this.host, this.port, this.creds());
      // macOS shows a sign-in that isn't the account at the screen a login screen of its own (a session it starts as
      // the sign-in is accepted), not the desktop: said, so the app can say what to do about it.
      const separate = await this.ownLoginScreen(started);
      this.last = { ok: true, problem: null, code: null, width: c.init.width, height: c.init.height, separate, at: Date.now() };
      c.close();
      if (separate && !wasSeparate) log.info(`macOS gave Crosstalk a login screen of its own, not the desktop (signed in ${this.deps.settings().username ? `as ${this.deps.settings().username}` : "with the VNC password"})`);
    } catch (e) {
      const err = e instanceof RfbError ? e : new RfbError(e instanceof Error ? e.message : String(e), "closed");
      this.last = { ok: false, problem: err.message, code: err.code ?? null, width: 0, height: 0 };
      this.dropAgent();
    }
    if (before !== this.ready() || wasSeparate !== !!this.last?.separate) this.deps.changed();
    return this.status();
  }

  /** The Mac's own Screen Sharing (not a test's server, nor a VNC server on another port). */
  private isMacScreen(): boolean {
    return osPlatform() === "darwin" && this.port === 5900 && this.deps.host === undefined && !process.env.CROSSTALK_SCREEN_HOST;
  }

  private async ownLoginScreen(since: number): Promise<boolean> {
    if (this.deps.ownLoginScreen) return this.deps.ownLoginScreen(since);
    if (!this.isMacScreen()) return false;
    // Signed in as the account at the screen, only one started just now counts (another viewer's may be around); any
    // other sign-in is looking at one whenever one exists (it stays some seconds after the last look, and is used again).
    const own = this.deps.settings().username.toLowerCase() === userInfo().username.toLowerCase();
    return macOwnLoginScreen(own ? since : 0);
  }

  /**
   * The account to sign in as, from what was typed: its short name, whether that or the full name was typed (the name
   * on the Mac's login screen is the full one, and Screen Sharing only knows the short one).
   */
  private async accountNamed(typed: string): Promise<string> {
    if (!typed || !(this.deps.accounts || this.isMacScreen())) return typed;
    const list = await (this.deps.accounts ?? macAccounts)();
    if (!list.length) return typed;
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
    const found = list.find((a) => same(a.name, typed)) ?? list.find((a) => same(a.fullName, typed));
    if (!found) throw new HttpError(400, `There's no account named "${typed}" on this Mac. Its accounts: ${list.map((a) => a.name).join(", ")}.`, "no_account");
    return found.name;
  }

  /** Settings → Screen: the password (null takes it away), the account name, and whether agents may use it. */
  async configure(input: { password?: unknown; username?: unknown; agents?: unknown }): Promise<ScreenStatus> {
    const s = { ...this.deps.settings() };
    if (input.username !== undefined) s.username = await this.accountNamed(String(input.username ?? "").trim().slice(0, 64));
    if (input.agents !== undefined) s.agents = !!input.agents;
    this.deps.save(s);
    if (input.password !== undefined) {
      const p = input.password === null ? "" : String(input.password);
      if (p.length > 128) throw new HttpError(400, "That password is too long.");
      this.deps.setPassword(p || null);
      this.dropAgent();
    }
    const out = input.password !== undefined || input.username !== undefined || !this.last ? await this.check() : this.status();
    this.deps.changed();
    return out;
  }

  // ---- the phone's live view ----

  /**
   * Signs in for a device's view and hands back the connection, ServerInit read. The device speaks RFB to the hub as if
   * to a server with no password (it is already a paired device): see server.ts for the other half.
   */
  async attachViewer(): Promise<RfbConnection> {
    try {
      const c = await rfbOpen(this.host, this.port, this.creds());
      if (!this.last?.ok) {
        this.last = { ok: true, problem: null, code: null, width: c.init.width, height: c.init.height };
        this.deps.changed();
      }
      this.viewers.add(c);
      return c;
    } catch (e) {
      const err = e instanceof RfbError ? e : new RfbError(String(e), "closed");
      const was = this.ready();
      this.last = { ok: false, problem: err.message, code: err.code, width: 0, height: 0 };
      if (was) this.deps.changed();
      throw new HttpError(409, err.message, `screen_${err.code}`);
    }
  }
  detachViewer(c: RfbConnection) {
    this.viewers.delete(c);
    c.close();
  }

  // ---- the agents' tools ----

  private dropAgent() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.agent?.close();
    this.agent = null;
  }
  private async client(): Promise<RfbClient> {
    if (!this.deps.settings().agents) throw new HttpError(403, `The person hasn't let agents use this machine's screen. They can turn it on in ${settingsPath("screen")}.`, "screen_agents_off");
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.dropAgent(), IDLE_MS);
    if (this.agent && !this.agent.closed) return this.agent;
    this.opening ??= RfbClient.connect(this.host, this.port, this.creds()).finally(() => (this.opening = null));
    try {
      const c = await this.opening;
      this.agent = c;
      if (!this.last?.ok) {
        this.last = { ok: true, problem: null, code: null, width: c.width, height: c.height };
        this.deps.changed();
      }
      // The first picture is the whole screen: wait for it before anything looks.
      if (!c.updates) await c.nextUpdate(4000);
      return c;
    } catch (e) {
      const err = e instanceof RfbError ? e : new RfbError(String(e), "closed");
      throw new HttpError(409, `The screen can't be reached: ${err.message}`, `screen_${err.code}`);
    }
  }
  /** Runs one action after the ones before it. */
  private inTurn<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }
  /** How the agents' picture maps to the screen: its size, and how many screen pixels one of its pixels covers. */
  private scaleOf(c: RfbClient) {
    const factor = Math.max(1, c.width / AGENT_WIDTH);
    return { factor, width: Math.round(c.width / factor), height: Math.round(c.height / factor) };
  }
  private toScreen(c: RfbClient, x: unknown, y: unknown): [number, number] {
    const { factor, width, height } = this.scaleOf(c);
    const px = Number(x), py = Number(y);
    if (!Number.isFinite(px) || !Number.isFinite(py) || px < 0 || py < 0 || px > width || py > height) throw new HttpError(400, `x and y are positions in the screenshot, which is ${width} × ${height}.`);
    return [px * factor, py * factor];
  }

  /** The screen as a PNG the agents can look at, at most 1280 wide. Positions in every other tool are this picture's. */
  screenshot(): Promise<{ png: Uint8Array; width: number; height: number }> {
    return this.inTurn(async () => {
      const c = await this.client();
      const { width, height } = this.scaleOf(c);
      return { png: encodePng(scaleRgb(c.pixels, c.width, c.height, width, height), width, height), width, height };
    });
  }

  click(input: { x: unknown; y: unknown; button?: unknown; count?: unknown }): Promise<string> {
    return this.inTurn(async () => {
      const c = await this.client();
      const [x, y] = this.toScreen(c, input.x, input.y);
      const button = input.button === "right" ? BUTTON.right : input.button === "middle" ? BUTTON.middle : BUTTON.left;
      const count = Math.max(1, Math.min(3, Math.round(Number(input.count) || 1)));
      c.pointer(x, y, 0);
      await Bun.sleep(40);
      for (let i = 0; i < count; i++) {
        c.pointer(x, y, button);
        await Bun.sleep(40);
        c.pointer(x, y, 0);
        if (i < count - 1) await Bun.sleep(90);
      }
      await c.settle();
      return `Clicked${count > 1 ? ` ${count} times` : ""}${button === BUTTON.right ? " (right button)" : ""} at ${Math.round(Number(input.x))}, ${Math.round(Number(input.y))}.`;
    });
  }

  move(input: { x: unknown; y: unknown }): Promise<string> {
    return this.inTurn(async () => {
      const c = await this.client();
      const [x, y] = this.toScreen(c, input.x, input.y);
      c.pointer(x, y, 0);
      await c.settle(150, 800);
      return "Moved the pointer.";
    });
  }

  drag(input: { fromX: unknown; fromY: unknown; toX: unknown; toY: unknown }): Promise<string> {
    return this.inTurn(async () => {
      const c = await this.client();
      const [x0, y0] = this.toScreen(c, input.fromX, input.fromY);
      const [x1, y1] = this.toScreen(c, input.toX, input.toY);
      c.pointer(x0, y0, 0);
      await Bun.sleep(60);
      c.pointer(x0, y0, BUTTON.left);
      // In steps: apps only notice a drag that moves.
      for (let i = 1; i <= 12; i++) {
        await Bun.sleep(25);
        c.pointer(x0 + ((x1 - x0) * i) / 12, y0 + ((y1 - y0) * i) / 12, BUTTON.left);
      }
      await Bun.sleep(80);
      c.pointer(x1, y1, 0);
      await c.settle();
      return "Dragged.";
    });
  }

  scroll(input: { x: unknown; y: unknown; direction?: unknown; amount?: unknown }): Promise<string> {
    return this.inTurn(async () => {
      const c = await this.client();
      const [x, y] = this.toScreen(c, input.x, input.y);
      const dir = String(input.direction ?? "down");
      const button = dir === "up" ? BUTTON.wheelUp : dir === "left" ? BUTTON.wheelLeft : dir === "right" ? BUTTON.wheelRight : BUTTON.wheelDown;
      const amount = Math.max(1, Math.min(30, Math.round(Number(input.amount) || 5)));
      c.pointer(x, y, 0);
      for (let i = 0; i < amount; i++) {
        c.pointer(x, y, button);
        c.pointer(x, y, 0);
        await Bun.sleep(15);
      }
      await c.settle();
      return `Scrolled ${dir}.`;
    });
  }

  type(input: { text: unknown }): Promise<string> {
    return this.inTurn(async () => {
      const c = await this.client();
      const text = String(input.text ?? "");
      if (!text) throw new HttpError(400, "Nothing to type.");
      if (text.length > 4000) throw new HttpError(400, "That's more than 4,000 characters: type it in parts, or write it to a file.");
      const SHIFT = 0xffe1;
      for (const ch of text) {
        const sym = keysymOf(ch);
        const shift = needsShift(ch);
        if (shift) c.key(SHIFT, true);
        c.key(sym, true);
        c.key(sym, false);
        if (shift) c.key(SHIFT, false);
        await Bun.sleep(8);
      }
      await c.settle(200, 1500);
      return `Typed ${[...text].length} character${[...text].length === 1 ? "" : "s"}.`;
    });
  }

  key(input: { keys: unknown }): Promise<string> {
    return this.inTurn(async () => {
      const c = await this.client();
      const combo = String(input.keys ?? "");
      const parsed = parseCombo(combo);
      if (!parsed) throw new HttpError(400, `"${combo}" isn't a key Crosstalk knows. Use names like Return, Escape, Tab, Delete, Space, Left, cmd+c, cmd+shift+4.`);
      for (const m of parsed.modifiers) c.key(m, true);
      c.key(parsed.key, true);
      await Bun.sleep(30);
      c.key(parsed.key, false);
      for (const m of [...parsed.modifiers].reverse()) c.key(m, false);
      await c.settle();
      return `Pressed ${combo}.`;
    });
  }

  // ---- the windows on screen ----

  /** The windows on screen, front to back, with whether each belongs to something this hub's agents run. */
  async windows(): Promise<ScreenWindow[]> {
    if (this.deps.windows) return this.deps.windows();
    if (osPlatform() !== "darwin") return [];
    return macWindows(this.deps.hubPid);
  }

  /** What an agent is told about the windows: where each is in its screenshot. */
  async windowsForAgent(): Promise<string> {
    const c = await this.client();
    const { factor } = this.scaleOf(c);
    const list = await this.windows();
    if (!list.length) return "No windows could be listed on this machine.";
    return list
      .map((w, i) => `${i + 1}. ${w.app}${w.title ? ` — ${w.title}` : ""}: x ${Math.round(w.x / factor)}, y ${Math.round(w.y / factor)}, ${Math.round(w.width / factor)} × ${Math.round(w.height / factor)}${w.agent ? " (started by an agent)" : ""}`)
      .join("\n");
  }

  private watch: ReturnType<typeof setInterval> | null = null;
  /**
   * Looks for the screen at the hub's start, and again every two minutes while it can't be reached (the person may turn
   * screen sharing on at any time) or nothing has looked for a while. Cheap: a connection to this same machine.
   */
  start() {
    void this.check().catch(() => {});
    this.watch = setInterval(() => {
      // One that answers is looked at again only now and then: on a Mac each look by a sign-in that isn't the
      // desktop's own account starts a login screen (and its processes) just to be looked at.
      const fresh = !!this.last?.ok && Date.now() - (this.last.at ?? 0) < RECHECK_MS;
      if (!this.ready() || (!this.agent && !this.viewers.size && !fresh)) void this.check().catch(() => {});
    }, 120_000);
  }

  shutdown() {
    if (this.watch) clearInterval(this.watch);
    this.dropAgent();
    for (const v of this.viewers) v.close();
    this.viewers.clear();
  }
}

/**
 * Whether macOS has a login screen of its own going, started since `since`: a `loginwindow` owned by root, beside the one of
 * the account whose desktop is on the screen (the hub runs in that account's session, so there is one). It's made as
 * the sign-in is accepted and goes again some seconds after the last viewer leaves.
 */
async function macOwnLoginScreen(since: number): Promise<boolean> {
  // `since` 0: one of any age.
  try {
    const ps = Bun.spawn(["/bin/ps", "-axo", "user=,etime=,command="], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(ps.stdout).text();
    const age = Math.ceil((Date.now() - since) / 1000) + 3;
    for (const line of out.split("\n")) {
      const m = /^\s*root\s+(\S+)\s+.*\/loginwindow\.app\/Contents\/MacOS\/loginwindow\b/.exec(line);
      if (!m) continue;
      // etime: [[dd-]hh:]mm:ss
      const parts = m[1]!.replace("-", ":").split(":").map(Number);
      const seconds = parts.reduce((total, n, i) => total + n * [1, 60, 3600, 86400][parts.length - 1 - i]!, 0);
      if (!since || seconds <= age) return true;
    }
  } catch (e) {
    log.debug(`couldn't look for a login screen: ${e instanceof Error ? e.message : String(e)}`);
  }
  return false;
}

/** This Mac's accounts that a person logs in to (not the system's own), by short and full name. */
async function macAccounts(): Promise<MacAccount[]> {
  try {
    const p = Bun.spawn(["/usr/bin/dscl", ".", "-list", "/Users", "RealName"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    return out
      .split("\n")
      .map((line) => /^(\S+)\s+(.*)$/.exec(line.trim()))
      .filter((m): m is RegExpExecArray => !!m && !m[1]!.startsWith("_") && !["root", "daemon", "nobody"].includes(m[1]!))
      .map((m) => ({ name: m[1]!, fullName: m[2]!.trim() }));
  } catch {
    return [];
  }
}

/** Apps whose windows are an agent's even though the hub didn't start them: the browser made for agents. */
const AGENT_APPS = /^BrowserOS/i;

/**
 * The on-screen windows of a Mac, front to back, from the window server (no permission is needed for their owners and
 * frames; titles come only where macOS gives them). Asked through `osascript`, so the hub needs no native code.
 */
async function macWindows(hubPid: number): Promise<ScreenWindow[]> {
  const script = `ObjC.import("CoreGraphics");
const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0)));
JSON.stringify(list.filter((w) => w.kCGWindowLayer === 0 && w.kCGWindowBounds.Width > 60 && w.kCGWindowBounds.Height > 40).map((w) => ({ id: w.kCGWindowNumber, app: w.kCGWindowOwnerName || "", pid: w.kCGWindowOwnerPID, title: w.kCGWindowName || "", x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y, width: w.kCGWindowBounds.Width, height: w.kCGWindowBounds.Height })));`;
  try {
    const [osa, ps] = await Promise.all([
      Bun.spawn(["/usr/bin/osascript", "-l", "JavaScript", "-e", script], { stdout: "pipe", stderr: "ignore" }),
      Bun.spawn(["/bin/ps", "-axo", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" }),
    ]);
    const [out, tree] = await Promise.all([new Response(osa.stdout).text(), new Response(ps.stdout).text()]);
    const parent = new Map<number, number>();
    for (const line of tree.split("\n")) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (pid) parent.set(pid, ppid ?? 0);
    }
    const underHub = (pid: number) => {
      for (let p = pid, hops = 0; p > 1 && hops < 40; p = parent.get(p) ?? 0, hops++) if (p === hubPid) return true;
      return false;
    };
    const raw = JSON.parse(out.trim() || "[]") as (Omit<ScreenWindow, "agent"> & { pid: number })[];
    return raw.map(({ pid, ...w }) => ({ ...w, agent: AGENT_APPS.test(w.app) || underHub(pid) }));
  } catch (e) {
    log.info(`couldn't list the windows: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
