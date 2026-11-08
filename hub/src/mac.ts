// This Mac as a hands-off server (Settings → This Mac): what keeps it from running unattended, checked without asking
// macOS anything that would put up a dialog, and the privacy dialogs macOS puts up (for the hub's agents or any app),
// told to the phone while they wait on the Mac's screen. Nothing here changes a setting and nothing answers a dialog:
// no software can (macOS ignores synthetic clicks on them, and pre-approving needs device management). The buttons open
// the right page of System Settings on the Mac, for the person to change it there, once.
//
// The dialogs come from macOS's privacy daemon's log (tccd, `log stream`), which says when one is put up
// (AUTHREQ_PROMPTING) and when it's answered (AUTHREQ_RESULT). Log text isn't an API: anything it doesn't recognize is
// skipped, quietly. The dialogs waiting are kept in a small file (RUN_DIR/mac.json), and what tccd logged while the hub
// was off is read back (`log show`) when it starts again.
//
// That file also has a heartbeat (written every minute), the boot the hub ran under and whether it stopped on purpose.
// When the Mac has started up since and the hub didn't stop, the Mac went down: with a panic report from then it
// crashed (a fault on a USB port restarts the whole machine, say), without one it lost power or froze. The phone is told
// once, and This Mac shows for a week what happened, what to change, and how long Crosstalk was off.

import { createHash } from "node:crypto";
import { MAC_LOGIN_WAIT_MS, type MacCrash, type MacDialog, type MacStatus } from "@crosstalk/shared";
import { HttpError } from "./engine/engine";
import { logger } from "./util/log";

const log = logger("mac");

export interface MacDeps {
  /** Runs a command: its exit code and output, or null if it couldn't run. */
  run: (args: string[], timeoutMs?: number) => Promise<{ code: number; out: string } | null>;
  /** Whether a file can be opened for reading (the system privacy database can only with Full Disk Access). */
  readable: (path: string) => boolean;
  /** Streams tccd's requests and answers, a line at a time; null where it can't be read. */
  stream: (onLine: (line: string) => void, onExit: () => void) => { stop(): void } | null;
  /** The same lines tccd logged since `start` (the Mac's local time, "2026-05-14 02:40:10"); null where they can't be read. */
  history?: (start: string) => Promise<string[] | null>;
  /** The dialogs waiting, whenever that changes. */
  emit: (dialogs: MacDialog[]) => void;
  /** A note for the phone; `always` also reaches phones showing the app. False: it reached none, try again later. */
  notify: (note: { title: string; body: string; tag: string }, opts?: { always?: boolean }) => Promise<boolean> | boolean | void;
  /** A notification that no longer applies (answered on the Mac): replaced by `text`. */
  dropNote: (tag: string, text: string) => void;
  /** The hub's own program, to tell its dialogs from an older build's. */
  self: string;
  /** What the machine is called ("Mac mini"). */
  name: () => string;
  /** What Tailscale says about this machine (`tailscale status --json`, parsed; null: it couldn't be asked). */
  tailscaleStatus?: () => Promise<Record<string, unknown> | null>;
  /** How long a dialog waits before the phone is told (someone at the Mac answers sooner). */
  notifyAfterMs?: number;
  /** The first wait before a crash note that reached no phone is sent again (tests: shorter). */
  noteRetryMs?: number;
  /** What was kept from the hub's last run (null: nothing), and keeping it. Without them nothing is kept. */
  readState?: () => string | null;
  writeState?: (text: string) => void;
  /** A folder's files with when each last changed (none where it can't be read), and a file's text: panic reports. */
  files?: (dir: string) => { name: string; mtime: number }[];
  readText?: (path: string) => string | null;
  /** Whether a process still runs (by default: signal 0 finds it). */
  alive?: (pid: number) => boolean;
}

/** Pages of System Settings a row opens, on the Mac's own screen. */
export const MAC_PANES = {
  fullDisk: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  login: "x-apple.systempreferences:com.apple.Users-Groups-Settings.extension",
  energy: "x-apple.systempreferences:com.apple.Battery-Settings.extension",
  updates: "x-apple.systempreferences:com.apple.Software-Update-Settings.extension",
  privacy: "x-apple.systempreferences:com.apple.preference.security?Privacy",
} as const;
export type MacPane = keyof typeof MAC_PANES;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Where macOS leaves a report after a kernel panic (readable without asking anything). */
const REPORTS = "/Library/Logs/DiagnosticReports";
const CRASH_TAG = "mac-crash";

/**
 * The fixed commands Settings → This Mac runs in a terminal on the Mac (POST /api/mac/fix), the person typing their own
 * password: automatic login, or never sleeping and starting up after a power cut. Null for anything else.
 */
export function macFixCommand(what: unknown, user: string): { title: string; argv: string[] } | null {
  // Through script(1): the hub's terminal isn't the command's controlling terminal, and without one sudo refuses
  // before asking ("a terminal is required to read the password"); script gives it one.
  const tty = ["/usr/bin/script", "-q", "/dev/null"];
  const commands: Record<string, { title: string; argv: string[] }> = {
    autologin: { title: "Automatic login", argv: [...tty, "/usr/bin/sudo", "/usr/sbin/sysadminctl", "-autologin", "set", "-userName", user, "-password", "-"] },
    power: { title: "Stay on", argv: [...tty, "/usr/bin/sudo", "/usr/bin/pmset", "-a", "sleep", "0", "autorestart", "1", "womp", "1"] },
  };
  // Its own keys only: "toString" is in every object.
  return typeof what === "string" && Object.hasOwn(commands, what) ? commands[what] : null;
}

/** What tccd says when it puts up a dialog. */
export interface Prompting {
  id: string;
  service: string;
  /** The process asking (0 when the line doesn't say). */
  pid: number;
  /** The app macOS asks about (whoever started the process asking). */
  responsible: string;
  identifier: string;
  binary: string;
}

/** "AUTHREQ_PROMPTING: msgID=75053.97, service=kTCCService…, subject=Sub:{…}Resp:{TCCDProcess: identifier=a.out, pid=…, responsible_path=…, binary_path=…}," */
export function parsePrompting(msg: string): Prompting | null {
  if (!msg.startsWith("AUTHREQ_PROMPTING:")) return null;
  const id = /msgID=([^,\s]+)/.exec(msg)?.[1];
  const service = /service=([^,\s]+)/.exec(msg)?.[1];
  if (!id || !service) return null;
  const field = (name: string) => new RegExp(`${name}=([^,}]+)`).exec(msg)?.[1]?.trim() ?? "";
  return { id, service, pid: Number(/\bpid=(\d+)/.exec(msg)?.[1] ?? 0), responsible: field("responsible_path"), identifier: field("identifier"), binary: field("binary_path") };
}

/** "AUTHREQ_RESULT: msgID=75053.97, authValue=2, authReason=2, …": 2 is allowed, 0 denied, 3 limited. */
export function parseResult(msg: string): { id: string; allowed: boolean | null } | null {
  if (!msg.startsWith("AUTHREQ_RESULT:")) return null;
  const id = /msgID=([^,\s]+)/.exec(msg)?.[1];
  if (!id) return null;
  const value = Number(/authValue=(\d+)/.exec(msg)?.[1]);
  return { id, allowed: value === 2 || value === 3 ? true : value === 0 ? false : null };
}

/** A line of tccd's log (ndjson): what it says, which tccd said it, when, and the whole of that to tell repeats apart. */
interface LogEvent {
  msg: string;
  tccd: string;
  at: number | null;
  key: string;
}

function logEvent(line: string): LogEvent | null {
  const text = line.trim().replace(/,$/, "");
  if (!text.startsWith("{")) return null;
  try {
    const e = JSON.parse(text) as { eventMessage?: unknown; processID?: unknown; timestamp?: unknown };
    const msg = String(e.eventMessage ?? "");
    const tccd = typeof e.processID === "number" ? String(e.processID) : "";
    const ts = typeof e.timestamp === "string" ? e.timestamp : "";
    return { msg, tccd, at: ts ? parseLogTime(ts) : null, key: `${tccd}|${ts}|${msg}` };
  } catch {
    return null;
  }
}

/**
 * A time as macOS's log and its panic reports write it ("2026-05-14 13:36:08.021220-0700", "2026-05-14 02:41:29.00
 * -0700"), read here rather than trusted to Date.parse.
 */
export function parseLogTime(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*([+-])(\d{2}):?(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const ms = Number(`${m[7] ?? ""}000`.slice(0, 3));
  const offset = (m[8] === "-" ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10])) * MINUTE;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms) - offset;
}

/** A time as `log show --start` takes it: the Mac's local time, "2026-05-14 02:40:10". */
export function logStart(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** How long a process has run, from `ps -o etime` ("[[dd-]hh:]mm:ss"), in ms. */
export function parseEtime(s: string): number | null {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return null;
  return (((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000;
}

/** When the Mac started up, from `sysctl -n kern.boottime` ("{ sec = 1778751682, usec = 339536 } Thu May 14 02:41:22 2026"). */
export function parseBoottime(out: string): number | null {
  const sec = /\bsec\s*=\s*(\d+)/.exec(out)?.[1];
  if (!sec) return null;
  return Number(sec) * 1000 + Math.floor(Number(/\busec\s*=\s*(\d+)/.exec(out)?.[1] ?? 0) / 1000);
}

/** The JSON object that starts at `from`, without the text after it (which JSON.parse refuses). */
function leadingJson(text: string, from: number): unknown {
  const start = text.indexOf("{", from);
  if (start < 0 || text.slice(from, start).trim()) return null;
  let depth = 0;
  let quoted = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{" || c === "[") depth++;
    else if ((c === "}" || c === "]") && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * A panic report (panic-full-….panic: a line of JSON, a JSON body, then text): when the panic happened and macOS's
 * message. Its time is the kernel's clock at the panic ("Calendar: 0x…" in the message); the header's is when the
 * report was written, after the restart.
 */
export function parsePanic(text: string): { at: number | null; panic: string } | null {
  const nl = text.indexOf("\n");
  if (nl < 0) return null;
  let header: { timestamp?: unknown };
  try {
    header = JSON.parse(text.slice(0, nl));
  } catch {
    return null;
  }
  const body = leadingJson(text, nl + 1) as { panicString?: unknown } | null;
  const panic = typeof body?.panicString === "string" ? body.panicString : "";
  if (!panic) return null;
  const cal = /Calendar:\s*0x([0-9a-f]+)(?:\s+0x([0-9a-f]+))?/i.exec(panic);
  const sec = cal ? parseInt(cal[1], 16) : 0;
  const at = sec > 0 ? sec * 1000 + Math.floor(parseInt(cal?.[2] ?? "0", 16) / 1000) : typeof header.timestamp === "string" ? parseLogTime(header.timestamp) : null;
  return { at, panic };
}

/** What a panic's message says caused it, in plain words, that message, and the USB bus when a USB port faulted (dart-usb3: 3). */
export function panicCause(panic: string): { cause: string; detail: string | null; usbBus: number | null } {
  // "panic(cpu 0 caller 0x…): "dart-usb3 (0x…): DART(DARTBLK) error: …" @AppleT8110DART.cpp:2386": the message itself.
  const message = (panic.split("\n")[0] ?? "")
    .trim()
    .replace(/^panic\([^)]*\):\s*/, "")
    .replace(/^"(.*)"(?:\s*@\S+)?$/, "$1")
    .trim();
  const detail = !message ? null : message.length > 160 ? `${message.slice(0, 159).trimEnd()}…` : message;
  const usb = /\bdart-usb(\d+)\b/i.exec(message);
  if (usb) return { cause: "a fault on a USB port", detail, usbBus: Number(usb[1]) };
  const dart = /\bdart-([a-z0-9]+)/i.exec(message)?.[1];
  const cause = dart ? `a hardware fault (${dart})` : /watchdog/i.test(message) ? "macOS stopped responding" : /thermal/i.test(message) ? "it got too hot" : "a kernel panic";
  return { cause, detail, usbBus: null };
}

interface UsbItem {
  _name?: unknown;
  _items?: unknown;
  USBKeyLocationID?: unknown;
  USBKeyHardwareType?: unknown;
  USBDeviceKeyVendorName?: unknown;
}

/** A maker's name worth showing: not filler ("xxxxxxxx", "Not Provided", a number) and not in the device's name already. */
function maker(vendor: unknown, name: string): string | null {
  const v = typeof vendor === "string" ? vendor.trim() : "";
  if (!/[a-z].*[a-z]/i.test(v) || /^(.)\1*$/.test(v) || /^(0x)?[0-9a-f]+$/i.test(v) || /^(not provided|unknown|none|n\/a|generic|vendor)$/i.test(v)) return null;
  return name.toLowerCase().includes(v.toLowerCase()) ? null : v;
}

/**
 * What's plugged into a USB bus now, from `system_profiler SPUSBHostDataType -json` (the bus at location 0x03000000 is
 * dart-usb3's): removable devices by name, with their maker when that's a real name. A hub is "a USB hub", listed first
 * (people know theirs as one); what's plugged into it is listed too.
 */
export function usbDevices(json: string, bus: number): string[] {
  let buses: UsbItem[] = [];
  try {
    const all = (JSON.parse(json) as { SPUSBHostDataType?: unknown }).SPUSBHostDataType;
    if (Array.isArray(all)) buses = all;
  } catch {
    return [];
  }
  const out: string[] = [];
  let hub = false;
  const walk = (items: unknown, inHub: boolean) => {
    if (!Array.isArray(items)) return;
    for (const d of items as UsbItem[]) {
      const name = typeof d?._name === "string" ? d._name.trim() : "";
      const removable = d?.USBKeyHardwareType === "Removable";
      const isHub = removable && /\bhub\b/i.test(name);
      if (isHub) hub = true;
      // A hub's own parts aren't something plugged in: the chip announcing its video mode calls itself something like
      // "USB Type-C Digital AV Adapter" (a USB Billboard device), whether or not the hub has a video port.
      else if (name && removable && !(inHub && /\b(AV Adapter|Billboard)\b/i.test(name))) {
        const by = maker(d.USBDeviceKeyVendorName, name);
        out.push(by ? `${name} (${by})` : name);
      }
      walk(d?._items, inHub || isHub);
    }
  };
  for (const b of buses) if (typeof b?.USBKeyLocationID === "string" && parseInt(b.USBKeyLocationID, 16) >>> 24 === bus) walk(b._items, false);
  return hub ? ["a USB hub", ...out] : out;
}

/** A time on the Mac's clock: "2:41 AM" on `now`'s day, "11:50 PM yesterday", or "11:50 PM on Oct 25". */
export function clock(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === new Date(now).toDateString()) return time;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `${time} yesterday`;
  return `${time} on ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

/**
 * The phone's notification when the Mac went down: when, why, and how long Crosstalk was off; after it waited at the
 * login screen, what to change, as This Mac says it (nothing when it logs in by itself now; with FileVault on it can't).
 */
export function crashNote(c: MacCrash, name: string, login: Pick<MacStatus, "autoLogin" | "fileVault">, now = Date.now()): { title: string; body: string } {
  const atLogin = c.waitedMs > MAC_LOGIN_WAIT_MS;
  const why = !atLogin
    ? "."
    : login.autoLogin
      ? ": it waited at the login screen."
      : login.fileVault
        ? ": it waited at the login screen for its FileVault password."
        : ": it waited at the login screen. Turn on automatic login in Settings → This Mac.";
  const off = `Crosstalk was off until ${clock(c.backAt, now)}${why}`;
  return c.kind === "crash"
    ? { title: `${name} crashed and restarted`, body: `At ${clock(c.at, now)} (${c.cause ?? "a kernel panic"}). ${off}` }
    : { title: `${name} restarted without shutting down`, body: `Around ${clock(c.at, now)}: it may have lost power or frozen. ${off}` };
}

const SERVICES: Record<string, string> = {
  SystemPolicyRemovableVolumes: "files on external drives",
  SystemPolicyNetworkVolumes: "files on network drives",
  SystemPolicyDesktopFolder: "the Desktop folder",
  SystemPolicyDocumentsFolder: "the Documents folder",
  SystemPolicyDownloadsFolder: "the Downloads folder",
  SystemPolicyAllFiles: "all files (Full Disk Access)",
  SystemPolicyAppData: "other apps' data",
  SystemPolicyAppBundles: "change other apps",
  MediaLibrary: "Apple Music and media",
  Photos: "Photos",
  PhotosAdd: "add to Photos",
  AppleEvents: "control another app",
  Accessibility: "control the Mac (Accessibility)",
  ScreenCapture: "record the screen",
  ListenEvent: "watch the keyboard (Input Monitoring)",
  PostEvent: "control the keyboard and mouse",
  Microphone: "the microphone",
  Camera: "the camera",
  AddressBook: "Contacts",
  Calendar: "Calendars",
  Reminders: "Reminders",
  BluetoothAlways: "Bluetooth",
  DeveloperTool: "run as a developer tool",
  FileProviderDomain: "files from a cloud drive",
  UserTracking: "tracking",
};

/** A tccd service name in plain words ("files on external drives"). */
export function serviceWords(service: string): string {
  const key = service.replace(/^kTCCService/, "");
  return SERVICES[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

const base = (p: string) => p.split("/").filter(Boolean).at(-1) ?? p;

/** A part of macOS: never stopped from the phone. */
const SYSTEM = /^\/(System|usr\/libexec|usr\/sbin|sbin)\//;

/** Who's asking, in plain words: the program, and the app macOS asks about when that's another one. */
export function askerWords(p: Prompting, self: string): string {
  const program = p.binary === self ? "Crosstalk" : base(p.binary) || p.identifier || "An app";
  const by = p.responsible;
  if (!by || by === p.binary) return program;
  if (by === self) return `${program} (started by Crosstalk)`;
  if (/crosstalk-hub/.test(base(by))) return `${program} (started by an older Crosstalk)`;
  if (p.identifier === "com.apple.Terminal" || /Terminal\.app/.test(by)) return `${program} (started from Terminal)`;
  return `${program} (started by ${base(by).replace(/\.app$/, "")})`;
}

/**
 * When Tailscale signs this machine out, from its status (`Self.KeyExpiry`; none: never). Nothing at all when Tailscale
 * couldn't be asked, so the row stays off the screen rather than claiming the machine never signs out.
 */
export function tailscaleExpiry(status: Record<string, unknown> | null): { tailscaleExpiry?: number | null } {
  const self = status?.Self as { KeyExpiry?: unknown } | undefined;
  if (!self || typeof self !== "object") return {};
  const at = typeof self.KeyExpiry === "string" ? Date.parse(self.KeyExpiry) : NaN;
  return { tailscaleExpiry: Number.isFinite(at) ? at : null };
}

/** `pmset -g`: minutes until the Mac sleeps (0: never), and whether it restarts after a power cut and wakes for the network. */
export function parsePmset(text: string): { sleep: number | null; autorestart: boolean | null; womp: boolean | null } {
  const num = (k: string) => {
    const m = new RegExp(`^\\s*${k}\\s+(\\d+)`, "m").exec(text);
    return m ? Number(m[1]) : null;
  };
  const sleep = num("sleep");
  const autorestart = num("autorestart");
  const womp = num("womp");
  return { sleep, autorestart: autorestart === null ? null : autorestart === 1, womp: womp === null ? null : womp === 1 };
}

interface Asker {
  binary: string;
  /** When it last asked: only a process started before then is the one that asked (its number may be reused since). */
  at: number;
}

interface Waiting {
  /** The phone's id for it and its notification's tag: the same for the same dialog, across restarts. */
  id: string;
  key: string;
  app: string;
  wants: string;
  since: number;
  /** tccd's requests it stands for, "<the tccd's process>/<msgID>" (tccd reuses msgIDs, and there are two of it). */
  ids: Set<string>;
  /** The processes asking, none a part of macOS (only those are ever stopped from the phone, and only while they run). */
  askers: Map<number, Asker>;
  notified: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

type SavedCrash = MacCrash & { dismissed?: boolean };

/** What's kept across the hub's restarts (RUN_DIR/mac.json). */
interface Saved {
  /** When the hub was last seen running: every minute, and with every change. */
  heartbeat: number;
  /** When the Mac had started up (kern.boottime), for that run, and that boot's id (kern.bootsessionuuid). */
  boot: number | null;
  bootId: string | null;
  /** The hub stopped on purpose (it shut down), so a restart of the Mac since then was an ordinary one. */
  clean: boolean;
  waiting: { key: string; app: string; wants: string; since: number; ids: string[]; askers: ({ pid: number } & Asker)[]; notified: boolean }[];
  crash: SavedCrash | null;
}

/** A process still runs: signal 0 finds it (another user's, after its number was reused, is found too). */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";

/** The kept state as last written, checked field by field (null: none, or not readable). */
function readSaved(text: string | null | undefined): Saved | null {
  let s: Record<string, unknown>;
  try {
    s = JSON.parse(text ?? "null");
  } catch {
    return null;
  }
  if (!s || typeof s !== "object" || !isNum(s.heartbeat)) return null;
  const waiting = (Array.isArray(s.waiting) ? (s.waiting as Record<string, unknown>[]) : [])
    .filter((w) => w && isStr(w.key) && isStr(w.app) && isStr(w.wants) && isNum(w.since) && Array.isArray(w.ids))
    .map((w) => ({
      key: w.key as string,
      app: w.app as string,
      wants: w.wants as string,
      since: w.since as number,
      ids: (w.ids as unknown[]).filter(isStr),
      askers: (Array.isArray(w.askers) ? (w.askers as Record<string, unknown>[]) : []).filter((a) => a && isNum(a.pid) && isStr(a.binary) && isNum(a.at)).map((a) => ({ pid: a.pid as number, binary: a.binary as string, at: a.at as number })),
      notified: w.notified === true,
    }));
  const c = s.crash as Record<string, unknown> | null | undefined;
  const crash: SavedCrash | null =
    c && isNum(c.at) && (c.kind === "crash" || c.kind === "power") && isNum(c.backAt) && isNum(c.waitedMs)
      ? { at: c.at, kind: c.kind, cause: isStr(c.cause) ? c.cause : null, detail: isStr(c.detail) ? c.detail : null, devices: Array.isArray(c.devices) ? c.devices.filter(isStr) : [], backAt: c.backAt, waitedMs: c.waitedMs, dismissed: c.dismissed === true }
      : null;
  return { heartbeat: s.heartbeat, boot: isNum(s.boot) ? s.boot : null, bootId: isStr(s.bootId) ? s.bootId : null, clean: s.clean === true, waiting, crash };
}

export class MacServer {
  private waiting = new Map<string, Waiting>();
  private byId = new Map<string, string>();
  private live: { stop(): void } | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private backoff = 5000;
  private stopped = true;
  /** Lines from the stream held while what tccd logged before them is read back (then each is handled once, in order). */
  private held: string[] | null = null;
  /** When the Mac started up, for this run, and that boot's id. */
  private boot: number | null = null;
  private bootId: string | null = null;
  private crash: SavedCrash | null = null;
  /** Caught up since starting: until then the kept file still says how the last run ended, so it isn't written. */
  private ready = false;
  private beat: ReturnType<typeof setInterval> | null = null;
  private noteRetry: ReturnType<typeof setTimeout> | null = null;
  /** The dialogs as last told to the app. */
  private shown = "[]";
  private runs = 0;

  constructor(private deps: MacDeps) {}

  /**
   * Starts watching for dialogs, with those still waiting when the hub stopped and what tccd logged meanwhile, and
   * tells the phone when the Mac went down since. Resolves once it has caught up.
   */
  start(): Promise<void> {
    if (!this.stopped) return Promise.resolve();
    this.stopped = false;
    this.ready = false;
    const run = ++this.runs;
    const saved = readSaved(this.deps.readState?.());
    this.crash = saved?.crash ?? null;
    this.held = saved && this.deps.history ? [] : null;
    this.listen();
    return this.catchUp(saved, run, Date.now());
  }

  private async catchUp(saved: Saved | null, run: number, started: number) {
    const current = () => run === this.runs && !this.stopped;
    try {
      const sys = (await this.deps.run(["/usr/sbin/sysctl", "-n", "kern.boottime", "kern.bootsessionuuid"]))?.out ?? "";
      if (!current()) return;
      this.boot = parseBoottime(sys);
      this.bootId = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.exec(sys)?.[0] ?? null;
      // The Mac started up since the hub last ran: another boot's id, or else another boot time (kern.boottime moves a
      // little when the clock is set).
      const rebooted = !!saved && (saved.bootId && this.bootId ? saved.bootId !== this.bootId : this.boot !== null && saved.boot !== null && Math.abs(this.boot - saved.boot) > MINUTE);
      if (saved) await this.recover(saved, rebooted, current);
      if (!current()) return;
      await this.wentDown(saved, rebooted, started, current);
    } catch (e) {
      log.warn(`catching up: ${e instanceof Error ? e.message : e}`);
    } finally {
      if (run === this.runs) {
        if (this.stopped) this.held = null;
        else {
          this.release();
          this.ready = true;
          this.save();
          // The heartbeat: how a crash or a power cut is told from an ordinary restart afterwards.
          this.beat = setInterval(() => this.tick(), MINUTE);
          this.beat.unref?.();
        }
      }
    }
  }

  /** The dialogs still waiting when the hub stopped (none outlive a restart of the Mac), and what tccd logged since. */
  private async recover(saved: Saved, rebooted: boolean, current: () => boolean) {
    for (const s of saved.waiting) {
      if (!rebooted) this.restore(s);
      else if (s.notified) this.deps.dropNote(tagOf(dialogId(s.key)), `Gone: ${this.deps.name()} restarted`);
    }
    if (this.waiting.size) this.changed();
    if (this.deps.history) {
      // From a minute before the last heartbeat (or since this boot), at most three days back.
      const from = Math.max(rebooted ? this.boot! : saved.heartbeat - MINUTE, Date.now() - 3 * DAY);
      const lines = await this.deps.history(logStart(from));
      if (!current()) return;
      const seen = new Set<string>();
      for (const line of lines ?? []) {
        const e = logEvent(line);
        if (!e) continue;
        seen.add(e.key);
        this.apply(e);
      }
      this.release(seen);
    }
    // Those not told to the phone yet are told after the usual wait.
    for (const w of this.waiting.values()) if (!w.notified && !w.timer) this.arm(w);
  }

  private restore(s: Saved["waiting"][number]) {
    if (this.waiting.has(s.key)) return;
    const w: Waiting = { id: dialogId(s.key), key: s.key, app: s.app, wants: s.wants, since: s.since, ids: new Set(s.ids), askers: new Map(s.askers.map((a) => [a.pid, { binary: a.binary, at: a.at }])), notified: s.notified, timer: null };
    this.waiting.set(w.key, w);
    for (const id of w.ids) this.byId.set(id, w.key);
  }

  /** The stream's lines held while catching up, handled now, except those read back already. */
  private release(seen?: Set<string>) {
    const held = this.held;
    this.held = null;
    for (const line of held ?? []) {
      const e = logEvent(line);
      if (!e || seen?.has(e.key)) continue;
      this.backoff = 5000;
      this.apply(e);
    }
  }

  /**
   * The Mac started up again without the hub stopping first: it crashed (a panic report from since the hub last ran)
   * or lost power or froze (none). The phone is told once, and This Mac shows it. With nothing kept yet (the first run
   * of this version), only a panic just before this boot counts, and the phone isn't told (it may be days old).
   */
  private async wentDown(saved: Saved | null, rebooted: boolean, started: number, current: () => boolean) {
    const boot = this.boot;
    if (boot === null || (saved && !rebooted)) return;
    const panic = this.panicSince((saved ? saved.heartbeat : boot) - 2 * MINUTE);
    if (!panic && (!saved || saved.clean)) return;
    const why = panic ? panicCause(panic.panic) : null;
    const bus = why?.usbBus ?? null;
    const usb = bus === null ? null : await this.deps.run(["/usr/sbin/system_profiler", "SPUSBHostDataType", "-json"], 30_000);
    // Crosstalk is back with this run; on the first run of this version, an older one came back when someone logged in.
    const backAt = saved ? started : ((await this.loggedInAt(boot)) ?? started);
    if (!current()) return;
    const crash: SavedCrash = {
      at: panic?.at ?? saved!.heartbeat,
      kind: panic ? "crash" : "power",
      cause: why?.cause ?? null,
      detail: why?.detail ?? null,
      devices: bus !== null && usb?.code === 0 ? usbDevices(usb.out, bus) : [],
      backAt,
      waitedMs: Math.max(0, backAt - boot),
    };
    this.crash = crash;
    log.warn(`${this.deps.name()} went down at ${new Date(crash.at).toISOString()}: ${crash.kind === "crash" ? crash.detail : "no panic report (power, or it froze)"}`);
    if (!saved) return;
    // After waiting at the login screen: automatic login to turn on, unless it's on now or FileVault rules it out.
    const login = crash.waitedMs > MAC_LOGIN_WAIT_MS ? await this.login() : { autoLogin: null, fileVault: null };
    if (!current()) return;
    this.sendCrash({ ...crashNote(crash, this.deps.name(), login), tag: CRASH_TAG }, crash);
  }

  /**
   * The crash note goes to every phone, the app open or not (This Mac is the only other place it shows), and is sent
   * again while it reaches none: right after the Mac starts up the network often isn't back yet.
   */
  private sendCrash(note: { title: string; body: string; tag: string }, crash: SavedCrash, tries = 0) {
    this.noteRetry = null;
    void Promise.resolve(this.deps.notify(note, { always: true }))
      .catch(() => false)
      .then((ok) => {
        if (ok !== false || this.stopped || this.crash?.at !== crash.at || this.crash.dismissed || tries >= 12) return;
        // 1, 2, 4 and 8 minutes, then every 10: about an hour and a half in all.
        const base = this.deps.noteRetryMs ?? MINUTE;
        this.noteRetry = setTimeout(() => this.sendCrash(note, crash, tries + 1), Math.min(2 ** tries, 10) * base);
        this.noteRetry.unref?.();
      });
  }

  /** The newest panic report (of the last two weeks) of a panic since `from`. */
  private panicSince(from: number): { at: number; panic: string } | null {
    const reports = (this.deps.files?.(REPORTS) ?? [])
      .filter((f) => /^panic-(full|base)-.*\.panic$/.test(f.name) && f.mtime > Date.now() - 14 * DAY)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 4);
    for (const f of reports) {
      const text = this.deps.readText?.(`${REPORTS}/${f.name}`);
      const p = text ? parsePanic(text) : null;
      if (p && p.at !== null && p.at >= from) return { at: p.at, panic: p.panic };
    }
    return null;
  }

  /** When the person logged in since `boot`: when their Dock started (null when that can't be told). */
  private async loggedInAt(boot: number): Promise<number | null> {
    const r = await this.deps.run(["/bin/ps", "-x", "-o", "etime=", "-o", "comm="]);
    const dock = r?.code === 0 ? /^\s*(\S+)\s+\S*\/Dock\s*$/m.exec(r.out) : null;
    const ran = dock ? parseEtime(dock[1]) : null;
    const at = ran === null ? null : Date.now() - ran;
    return at !== null && at >= boot - MINUTE ? at : null;
  }

  stop() {
    const was = !this.stopped;
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.live?.stop();
    this.live = null;
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
    if (this.noteRetry) clearTimeout(this.noteRetry);
    this.noteRetry = null;
    for (const w of this.waiting.values()) {
      if (w.timer) clearTimeout(w.timer);
      w.timer = null;
    }
    // Stopped on purpose: a restart of the Mac from now on is an ordinary one.
    if (was) this.save();
  }

  private listen() {
    if (this.stopped) return;
    this.live = this.deps.stream(
      (line) => this.line(line),
      () => {
        this.live = null;
        if (this.stopped) return;
        // Ended (macOS restarted logd, say): looked at again soon, then less often while it keeps ending.
        this.retry = setTimeout(() => this.listen(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 5 * 60_000);
      },
    );
  }

  /** One line of the stream (ndjson, or a header line that isn't). */
  line(line: string) {
    if (this.held) return void this.held.push(line);
    const e = logEvent(line);
    if (!e) return;
    this.backoff = 5000;
    this.apply(e);
  }

  private apply(e: LogEvent) {
    const asked = parsePrompting(e.msg);
    if (asked) return this.asked(asked, `${e.tccd}/${asked.id}`, e.at ?? Date.now());
    const answered = parseResult(e.msg);
    if (answered) this.answered(`${e.tccd}/${answered.id}`);
  }

  private asked(p: Prompting, id: string, at: number) {
    if (this.byId.has(id)) return;
    const app = askerWords(p, this.deps.self);
    const wants = serviceWords(p.service);
    const key = `${app}|${wants}`;
    let w = this.waiting.get(key);
    if (!w) {
      w = { id: dialogId(key), key, app, wants, since: at, ids: new Set(), askers: new Map(), notified: false, timer: null };
      this.waiting.set(key, w);
      this.arm(w);
    }
    w.ids.add(id);
    if (p.pid > 1 && p.pid !== process.pid && p.binary && !SYSTEM.test(p.binary)) w.askers.set(p.pid, { binary: p.binary, at: Math.max(w.askers.get(p.pid)?.at ?? 0, at) });
    this.byId.set(id, key);
    log.info(`macOS asks: ${app} wants ${wants}`);
    this.changed();
  }

  /** Someone at the Mac answers in seconds; a dialog still there after that is waiting for whoever's away. */
  private arm(w: Waiting) {
    w.timer = setTimeout(() => {
      w.timer = null;
      if (this.waiting.get(w.key) !== w || w.notified) return;
      w.notified = true;
      const name = this.deps.name();
      this.deps.notify({ title: `${name} is waiting for an answer`, body: `${w.app} wants ${w.wants}. Answer it on ${name}: it waits until someone does.`, tag: tagOf(w.id) });
      this.save();
    }, this.deps.notifyAfterMs ?? 20_000);
  }

  private answered(id: string) {
    const key = this.byId.get(id);
    if (!key) return;
    this.byId.delete(id);
    const w = this.waiting.get(key);
    if (!w) return;
    w.ids.delete(id);
    if (w.ids.size) return this.save();
    this.forget(w, `Answered on ${this.deps.name()}`);
  }

  /** Taken off the list: answered on the Mac, or dismissed from the phone. */
  private forget(w: Waiting, text: string) {
    if (w.timer) clearTimeout(w.timer);
    w.timer = null;
    for (const id of w.ids) this.byId.delete(id);
    this.waiting.delete(w.key);
    if (w.notified) this.deps.dropNote(tagOf(w.id), text);
    this.changed();
  }

  private find(id: string): Waiting {
    const w = [...this.waiting.values()].find((x) => x.id === id);
    if (!w) throw new HttpError(404, "That one isn't waiting any more.");
    return w;
  }

  /** Dismissed from the phone (the dialog was answered while the hub wasn't listening, say). */
  dismiss(id: string) {
    this.forget(this.find(id), "Dismissed");
    return this.status();
  }

  /**
   * Stops the program asking (POST /api/mac/dialogs/:id/stop): its own process, one this user runs, never a part of
   * macOS. That doesn't answer the question: it may stay on the Mac's screen until someone answers it there, but
   * nothing waits on it any more.
   */
  async stopAsker(id: string) {
    const w = this.find(id);
    let stopped = 0;
    let dropped = false;
    for (const [pid, a] of [...w.askers]) {
      if (await this.stillAsking(pid, a)) {
        try {
          process.kill(pid, "SIGTERM");
          stopped++;
          continue;
        } catch {
          // Gone already, or not this user's.
        }
      }
      // Nothing of it left to stop (its number may be another program's now), so no Stop for it: unless it asked again
      // meanwhile.
      if (w.askers.get(pid) === a) {
        w.askers.delete(pid);
        dropped = true;
      }
    }
    if (!stopped) {
      // The app is told, so the row (still there for Dismiss) loses its Stop.
      if (dropped) this.changed();
      throw new HttpError(409, `The program that asked has already stopped. The question may still be on ${this.deps.name()}'s screen; it waits for nothing now.`, "gone");
    }
    this.forget(w, "Stopped from the phone");
    return this.status();
  }

  /**
   * The process with that number is still the one that asked: the same program, running since before it asked (not a
   * later one given its number), and not a part of macOS.
   */
  private async stillAsking(pid: number, a: Asker): Promise<boolean> {
    if (SYSTEM.test(a.binary)) return false;
    const r = await this.deps.run(["/bin/ps", "-o", "etime=", "-o", "comm=", "-p", String(pid)]);
    const m = r?.code === 0 ? /^\s*(\S+)\s+(.+?)\s*$/.exec(r.out) : null;
    if (!m || !(a.binary.endsWith(m[2]) || m[2].endsWith(base(a.binary)))) return false;
    const ran = parseEtime(m[1]);
    // ps counts whole seconds: a little slack.
    return ran !== null && Date.now() - ran <= a.at + 2000;
  }

  dialogs(): MacDialog[] {
    this.prune();
    return [...this.waiting.values()].map((w) => ({ id: w.id, app: w.app, wants: w.wants, since: w.since, count: w.ids.size, stoppable: w.askers.size > 0 })).sort((a, b) => a.since - b.since);
  }

  /** Programs that asked and have exited since are forgotten: nothing is left to stop. */
  private prune() {
    const alive = this.deps.alive ?? running;
    for (const w of this.waiting.values()) for (const pid of [...w.askers.keys()]) if (!alive(pid)) w.askers.delete(pid);
  }

  private changed() {
    const list = this.dialogs();
    this.shown = JSON.stringify(list);
    this.deps.emit(list);
    this.save();
  }

  /** Every minute: the heartbeat, and the app told when a program that asked has exited (no Stop for it now). */
  private tick() {
    if (JSON.stringify(this.dialogs()) !== this.shown) this.changed();
    else this.save();
  }

  /** Writes what's kept (once caught up after starting). */
  private save() {
    if (!this.ready || !this.deps.writeState) return;
    const saved: Saved = {
      heartbeat: Date.now(),
      boot: this.boot,
      bootId: this.bootId,
      clean: this.stopped,
      waiting: [...this.waiting.values()].map((w) => ({ key: w.key, app: w.app, wants: w.wants, since: w.since, ids: [...w.ids], askers: [...w.askers].map(([pid, a]) => ({ pid, ...a })), notified: w.notified })),
      crash: this.crash,
    };
    try {
      this.deps.writeState(JSON.stringify(saved));
    } catch (e) {
      log.warn(`couldn't keep This Mac's state: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** The last time the Mac went down, while it's shown: a week, unless it's dismissed. */
  private lastCrash(): MacCrash | null {
    const c = this.crash;
    if (!c || c.dismissed || Date.now() - c.at > 7 * DAY) return null;
    const { dismissed: _, ...shown } = c;
    return shown;
  }

  /** The notice of the last crash put away (POST /api/mac/crash/dismiss). */
  dismissCrash() {
    if (this.crash && !this.crash.dismissed) {
      this.crash = { ...this.crash, dismissed: true };
      this.save();
      this.deps.dropNote(CRASH_TAG, "Dismissed");
    }
    return this.status();
  }

  /** Who the Mac logs in as by itself after a restart, if anyone, and whether FileVault is on (then it can't). */
  private async login(): Promise<Pick<MacStatus, "autoLogin" | "fileVault">> {
    const [user, vault] = await Promise.all([this.deps.run(["/usr/bin/defaults", "read", "/Library/Preferences/com.apple.loginwindow", "autoLoginUser"]), this.deps.run(["/usr/bin/fdesetup", "status"])]);
    return {
      autoLogin: user?.code === 0 && user.out.trim() ? user.out.trim() : null,
      fileVault: vault?.code === 0 ? (/FileVault is On/i.test(vault.out) ? true : /FileVault is Off/i.test(vault.out) ? false : null) : null,
    };
  }

  /** What Settings shows (GET /api/mac): everything checked again, read only. */
  async status(): Promise<MacStatus> {
    const [login, pm, updates, tailnet] = await Promise.all([
      this.login(),
      this.deps.run(["/usr/bin/pmset", "-g"]),
      this.deps.run(["/usr/bin/defaults", "read", "/Library/Preferences/com.apple.SoftwareUpdate", "AutomaticallyInstallMacOSUpdates"]),
      // Asked of the Tailscale running here, about this machine only (nothing is sent anywhere); the shared asker
      // (hub/src/tailscale.ts) tries the command and the Tailscale app's own API, so the app's GUI quirk can't hide it.
      this.deps.tailscaleStatus?.() ?? Promise.resolve(null),
    ]);
    const power = pm?.code === 0 ? parsePmset(pm.out) : null;
    return {
      // Only with Full Disk Access can the system's privacy database be opened at all (no dialog either way).
      fullDiskAccess: this.deps.readable("/Library/Application Support/com.apple.TCC/TCC.db"),
      autoLogin: login.autoLogin,
      fileVault: login.fileVault,
      sleepMinutes: power?.sleep ?? null,
      restartsAfterPowerCut: power?.autorestart ?? null,
      wakesForNetwork: power?.womp ?? null,
      autoUpdates: updates?.code === 0 ? updates.out.trim() === "1" : updates ? false : null,
      ...tailscaleExpiry(tailnet),
      dialogs: this.dialogs(),
      lastCrash: this.lastCrash(),
      checkedAt: Date.now(),
    };
  }

  /** Opens a page of System Settings on the Mac's screen (POST /api/mac/open), for the person to change it there. */
  async open(pane: unknown): Promise<{ ok: true }> {
    // Its own keys only ("toString" is in every object).
    if (typeof pane !== "string" || !Object.hasOwn(MAC_PANES, pane)) throw new HttpError(400, "Which page? fullDisk, login, energy, updates or privacy.");
    const r = await this.deps.run(["/usr/bin/open", MAC_PANES[pane as MacPane]]);
    if (!r || r.code !== 0) throw new HttpError(502, `System Settings didn't open on ${this.deps.name()}.`);
    return { ok: true };
  }
}

/** A dialog's id (and its notification's tag with it): the same for the same dialog across restarts, never another's. */
const dialogId = (key: string) => createHash("sha256").update(key).digest("base64url").slice(0, 22);
const tagOf = (id: string) => `mac-${id}`;
