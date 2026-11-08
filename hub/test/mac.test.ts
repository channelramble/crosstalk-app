import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAC_LOGIN_WAIT_MS, type MacDialog } from "@crosstalk/shared";
import { MacServer, askerWords, clock, crashNote, logStart, panicCause, parseBoottime, parseEtime, parseLogTime, parsePanic, parsePmset, parsePrompting, parseResult, serviceWords, tailscaleExpiry, usbDevices, type MacDeps, macFixCommand } from "../src/mac";

// Lines as tccd logs them (an adb server an older hub build started, asking for external drives).
const HUB = "/Users/me/.local/bin/crosstalk-hub";
const OLD = "/Users/me/Downloads/crosstalk-0.3/crosstalk-hub";
const ADB = "/opt/tools/platform-tools/adb";
type Logged = { processID?: number; timestamp?: string };
const prompting = (id: string, responsible = OLD, binary = ADB, service = "kTCCServiceSystemPolicyRemovableVolumes", identifier = "a.out", pid = 14288, logged: Logged = {}) =>
  JSON.stringify({ subsystem: "com.apple.TCC", ...logged, eventMessage: `AUTHREQ_PROMPTING: msgID=${id}, service=${service}, subject=Sub:{${responsible}}Resp:{TCCDProcess: identifier=${identifier}, pid=${pid}, auid=501, euid=501, responsible_path=${responsible}, binary_path=${binary}},` });
const result = (id: string, value = 2, logged: Logged = {}) => JSON.stringify({ subsystem: "com.apple.TCC", ...logged, eventMessage: `AUTHREQ_RESULT: msgID=${id}, authValue=${value}, authReason=2, authVersion=1, desired_auth=0, error=(null),` });
const python = (id: string, service: string, logged: Logged = {}, pid = 7001) => prompting(id, HUB, "/usr/bin/python3", service, "com.crosstalk.hub", pid, logged);

/** A time as macOS's log writes it, on this machine's clock: "2026-05-14 13:36:08.021000-0700". */
function logTs(ms: number): string {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${logStart(ms)}.${p(d.getMilliseconds(), 3)}000${off < 0 ? "-" : "+"}${p(Math.floor(Math.abs(off) / 60))}${p(Math.abs(off) % 60)}`;
}
/** What `sysctl -n kern.boottime` says for a boot at `ms`. */
const boottime = (ms: number) => `{ sec = ${Math.floor(ms / 1000)}, usec = ${(ms % 1000) * 1000} } Thu May 14 02:41:22 2026\n`;

const NAME = "Mac mini";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FIXTURES = join(import.meta.dir, "fixtures", "mac");
// A panic report (trimmed, made up), with the text macOS puts after its JSON.
const PANIC_FILE = "panic-full-2026-05-14-024129.0002.panic";
const PANIC = readFileSync(join(FIXTURES, PANIC_FILE), "utf8");
const USB = readFileSync(join(FIXTURES, "usb-host.json"), "utf8");
const REPORTS = "/Library/Logs/DiagnosticReports";
/** The report, as if the panic had been at `ms` (its kernel clock line). */
const panicAt = (ms: number) => PANIC.replace(/Calendar: 0x[0-9a-f]+ 0x[0-9a-f]+/, `Calendar: 0x${Math.floor(ms / 1000).toString(16)} 0x${((ms % 1000) * 1000).toString(16)}`);

function server(over: Partial<MacDeps> = {}) {
  const emitted: MacDialog[][] = [];
  const notes: { title: string; body: string; tag: string }[] = [];
  const dropped: { tag: string; text: string }[] = [];
  const ran: string[][] = [];
  let feed: ((line: string) => void) | null = null;
  let ended: (() => void) | null = null;
  let streams = 0;
  const mac = new MacServer({
    run: async (args) => {
      ran.push(args);
      return { code: 0, out: "" };
    },
    readable: () => false,
    stream: (onLine, onExit) => {
      streams++;
      feed = onLine;
      ended = onExit;
      return { stop: () => {} };
    },
    emit: (s) => emitted.push(s),
    notify: (n) => void notes.push(n),
    dropNote: (tag, text) => dropped.push({ tag, text }),
    self: HUB,
    name: () => NAME,
    notifyAfterMs: 30,
    // The programs asking in these lines are taken to be running (their numbers are made up).
    alive: () => true,
    ...over,
  });
  return { mac, emitted, notes, dropped, ran, line: (l: string) => feed!(l), end: () => ended!(), streams: () => streams };
}

/** A kept state in memory, as RUN_DIR/mac.json is on a Mac. */
function memory(text: string | null = null) {
  const kept = { text };
  return { kept, readState: () => kept.text, writeState: (t: string) => void (kept.text = t) };
}

test("tccd's lines read as who asks for what, in plain words", () => {
  const p = parsePrompting(JSON.parse(prompting("75053.97")).eventMessage)!;
  expect(p).toEqual({ id: "75053.97", service: "kTCCServiceSystemPolicyRemovableVolumes", pid: 14288, responsible: OLD, identifier: "a.out", binary: ADB });
  expect(askerWords(p, HUB)).toBe("adb (started by an older Crosstalk)");
  expect(askerWords({ ...p, responsible: HUB }, HUB)).toBe("adb (started by Crosstalk)");
  expect(askerWords({ ...p, responsible: HUB, binary: HUB }, HUB)).toBe("Crosstalk");
  expect(askerWords({ ...p, responsible: "/System/Applications/Utilities/Terminal.app", identifier: "com.apple.Terminal", binary: "/opt/homebrew/bin/rg" }, HUB)).toBe("rg (started from Terminal)");
  expect(askerWords({ ...p, responsible: "/Applications/Kimi.app", identifier: "com.moonshot.kimichat", binary: "/Applications/Kimi.app" }, HUB)).toBe("Kimi.app");
  expect(serviceWords("kTCCServiceSystemPolicyRemovableVolumes")).toBe("files on external drives");
  expect(serviceWords("kTCCServiceMicrophone")).toBe("the microphone");
  expect(serviceWords("kTCCServiceSomethingNew")).toBe("something new");
  expect(parseResult(JSON.parse(result("75053.97")).eventMessage)).toEqual({ id: "75053.97", allowed: true });
  expect(parseResult(JSON.parse(result("1.1", 0)).eventMessage)).toEqual({ id: "1.1", allowed: false });
  expect(parsePrompting("AUTHREQ_CTX: msgID=1, service=x")).toBeNull();
  expect(parsePmset("System-wide power settings:\nCurrently in use:\n sleep                0 (sleep prevented by sharingd)\n autorestart          1\n womp                 1\n displaysleep         10\n")).toEqual({ sleep: 0, autorestart: true, womp: true });
  expect(parsePmset(" sleep                1\n autorestart          0\n")).toEqual({ sleep: 1, autorestart: false, womp: null });
  // Tailscale: key expiry off (none), on (a date), or not answering.
  expect(tailscaleExpiry({ Self: { HostName: "mac", KeyExpiry: null } })).toEqual({ tailscaleExpiry: null });
  expect(tailscaleExpiry({ Self: { KeyExpiry: "2027-04-01T10:00:00Z" } })).toEqual({ tailscaleExpiry: Date.parse("2027-04-01T10:00:00Z") });
  // Tailscale couldn't be asked, or said nothing about this machine: the row stays off the screen.
  expect(tailscaleExpiry({})).toEqual({});
  expect(tailscaleExpiry(null)).toEqual({});
});

test("times as macOS writes them: its log, ps, kern.boottime, and the Mac's clock in words", () => {
  // The log's own times (and a panic report's header), with their offset.
  expect(parseLogTime("2026-05-14 13:36:08.021220-0700")).toBe(Date.UTC(2026, 4, 14, 20, 36, 8, 21));
  expect(parseLogTime("2026-05-14 02:41:29.00 -0700")).toBe(Date.UTC(2026, 4, 14, 9, 41, 29));
  expect(parseLogTime("2026-05-14 09:41:29+0000")).toBe(Date.UTC(2026, 4, 14, 9, 41, 29));
  expect(parseLogTime("Thu May 14 02:41:22 2026")).toBeNull();
  const t = new Date(2026, 4, 14, 2, 40, 10, 250).getTime();
  expect(logStart(t)).toBe("2026-05-14 02:40:10");
  expect(parseLogTime(logTs(t))).toBe(t);
  // ps's elapsed time: [[dd-]hh:]mm:ss.
  expect(parseEtime("00:05")).toBe(5_000);
  expect(parseEtime("  17:14\n")).toBe((17 * 60 + 14) * 1000);
  expect(parseEtime("11:17:14")).toBe(((11 * 60 + 17) * 60 + 14) * 1000);
  expect(parseEtime("1-02:03:04")).toBe((((24 + 2) * 60 + 3) * 60 + 4) * 1000);
  expect(parseEtime("Thu May 14 13:36:21 2026")).toBeNull();
  expect(parseBoottime("{ sec = 1778751682, usec = 339536 } Thu May 14 02:41:22 2026\n")).toBe(1778751682339);
  expect(parseBoottime("")).toBeNull();
  // In words: the time alone that day, then "yesterday", then the date.
  const back = new Date(2026, 4, 14, 9, 21).getTime();
  expect(clock(new Date(2026, 4, 14, 2, 41).getTime(), back)).toBe("2:41 AM");
  expect(clock(new Date(2026, 4, 13, 23, 50).getTime(), back)).toBe("11:50 PM yesterday");
  expect(clock(new Date(2026, 4, 11, 23, 50).getTime(), back)).toBe("11:50 PM on May 11");
});

test("a dialog still waiting after a moment is told to the phone, once for repeats, and taken back when it's answered", async () => {
  const s = server();
  void s.mac.start();
  s.line("Filtering the log data using \"subsystem == \\\"com.apple.TCC\\\"\"");
  s.line(prompting("75053.97"));
  s.line(prompting("48242.1"));
  expect(s.mac.dialogs()).toEqual([{ id: expect.any(String), app: "adb (started by an older Crosstalk)", wants: "files on external drives", since: expect.any(Number), count: 2, stoppable: true }]);
  expect(s.emitted.at(-1)!).toHaveLength(1);
  expect(s.notes).toHaveLength(0);
  await Bun.sleep(60);
  expect(s.notes).toEqual([{ title: "Mac mini is waiting for an answer", body: "adb (started by an older Crosstalk) wants files on external drives. Answer it on Mac mini: it waits until someone does.", tag: expect.stringMatching(/^mac-[\w-]{22}$/) }]);
  // Answered on the Mac: both requests resolve, and the notification says so instead.
  s.line(result("75053.97"));
  expect(s.mac.dialogs()).toHaveLength(1);
  s.line(result("48242.1"));
  expect(s.mac.dialogs()).toEqual([]);
  expect(s.dropped).toEqual([{ tag: s.notes[0].tag, text: "Answered on Mac mini" }]);
  expect(s.emitted.at(-1)!).toEqual([]);
  s.mac.stop();
});

test("one program asking for two things gets two dialogs, each with its own id and notification, the same after a restart", async () => {
  // "python3 (started by Crosstalk)" fills what an id used to keep of a dialog, so both had the same one.
  const s = server();
  void s.mac.start();
  s.line(python("1.1", "kTCCServiceSystemPolicyDownloadsFolder"));
  s.line(python("2.1", "kTCCServiceSystemPolicyDesktopFolder", {}, 7002));
  const [downloads, desktop] = s.mac.dialogs();
  expect([downloads.wants, desktop.wants]).toEqual(["the Downloads folder", "the Desktop folder"]);
  expect(downloads.app).toBe(desktop.app);
  expect(downloads.id).toMatch(/^[\w-]{22}$/);
  expect(desktop.id).not.toBe(downloads.id);
  await Bun.sleep(60);
  expect(s.notes.map((n) => n.body)).toEqual([expect.stringContaining("the Downloads folder"), expect.stringContaining("the Desktop folder")]);
  const [downloadsTag, desktopTag] = s.notes.map((n) => n.tag);
  expect(downloadsTag).toBe(`mac-${downloads.id}`);
  expect(desktopTag).toBe(`mac-${desktop.id}`);
  // Answering one takes back its own notification only, and Dismiss finds the one it's given.
  s.line(result("1.1"));
  expect(s.dropped).toEqual([{ tag: downloadsTag, text: "Answered on Mac mini" }]);
  expect(s.mac.dialogs().map((d) => d.id)).toEqual([desktop.id]);
  s.line(python("3.1", "kTCCServiceSystemPolicyDocumentsFolder", {}, 7003));
  await s.mac.dismiss(desktop.id);
  expect(s.mac.dialogs().map((d) => d.wants)).toEqual(["the Documents folder"]);
  expect(s.dropped.at(-1)).toEqual({ tag: desktopTag, text: "Dismissed" });
  s.mac.stop();
  // The same dialog seen by another run of the hub has the same id (and so the same notification).
  const again = server();
  void again.mac.start();
  again.line(python("9.1", "kTCCServiceSystemPolicyDesktopFolder"));
  expect(again.mac.dialogs()[0].id).toBe(desktop.id);
  again.mac.stop();
});

test("an answer counts for the request of the tccd that logged it (tccd reuses msgIDs, and there are two of it)", () => {
  const s = server();
  void s.mac.start();
  s.line(prompting("63609.1", OLD, ADB, undefined, undefined, undefined, { processID: 74997 }));
  // The other tccd's request with the same msgID, answered at once: not this one's answer.
  s.line(prompting("63609.1", OLD, ADB, undefined, undefined, undefined, { processID: 75011 }));
  expect(s.mac.dialogs()[0].count).toBe(2);
  s.line(result("63609.1", 2, { processID: 75011 }));
  expect(s.mac.dialogs()).toMatchObject([{ count: 1 }]);
  s.line(result("63609.1", 2, { processID: 74997 }));
  expect(s.mac.dialogs()).toEqual([]);
  s.mac.stop();
});

test("one answered at once at the Mac is never told to the phone; one can be dismissed from the phone", async () => {
  const s = server();
  void s.mac.start();
  s.line(prompting("1.1", HUB, HUB, "kTCCServiceSystemPolicyDocumentsFolder", "com.crosstalk.hub"));
  s.line(result("1.1"));
  await Bun.sleep(60);
  expect(s.notes).toHaveLength(0);
  expect(s.dropped).toHaveLength(0);
  s.line(prompting("2.1", HUB, "/usr/bin/python3", "kTCCServiceSystemPolicyDownloadsFolder", "com.crosstalk.hub"));
  const [d] = s.mac.dialogs();
  expect(d.app).toBe("python3 (started by Crosstalk)");
  expect(s.mac.dismiss(d.id)).resolves.toMatchObject({ dialogs: [] });
  expect(() => s.mac.dismiss(d.id)).toThrow("isn't waiting any more");
  s.mac.stop();
});

test("the stream is started again when it ends, and nothing is started once stopped", async () => {
  const s = server();
  void s.mac.start();
  expect(s.streams()).toBe(1);
  s.mac.stop();
  s.end();
  await Bun.sleep(20);
  expect(s.streams()).toBe(1);
});

test("Settings reads what keeps the Mac from running unattended, changing nothing, and opens System Settings on it", async () => {
  const outputs: Record<string, { code: number; out: string }> = {
    "autoLoginUser": { code: 1, out: "" },
    "status": { code: 0, out: "FileVault is Off.\n" },
    "-g": { code: 0, out: " sleep                0\n autorestart          0\n womp                 1\n" },
    "AutomaticallyInstallMacOSUpdates": { code: 0, out: "1\n" },
  };
  const s = server({
    run: async (args) => {
      s.ran.push(args);
      return outputs[args.at(-1)!] ?? { code: 0, out: "" };
    },
  });
  expect(await s.mac.status()).toEqual({ fullDiskAccess: false, autoLogin: null, fileVault: false, sleepMinutes: 0, restartsAfterPowerCut: false, wakesForNetwork: true, autoUpdates: true, dialogs: [], lastCrash: null, checkedAt: expect.any(Number) });
  // Only reading commands ran.
  expect(s.ran.map((a) => a[0])).toEqual(["/usr/bin/defaults", "/usr/bin/fdesetup", "/usr/bin/pmset", "/usr/bin/defaults"]);
  expect(s.ran.every((a) => !a.includes("write") && !a.includes("-a") && !a.includes("enable"))).toBe(true);
  outputs.autoLoginUser = { code: 0, out: "jane\n" };
  expect((await s.mac.status()).autoLogin).toBe("jane");
  await s.mac.open("fullDisk");
  expect(s.ran.at(-1)).toEqual(["/usr/bin/open", "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"]);
  await s.mac.open("login");
  expect(s.ran.at(-1)).toEqual(["/usr/bin/open", "x-apple.systempreferences:com.apple.Users-Groups-Settings.extension"]);
  await expect(s.mac.open("somewhere")).rejects.toMatchObject({ status: 400 });
  await expect(s.mac.open("x-apple.systempreferences:evil")).rejects.toMatchObject({ status: 400 });
});

test("open takes only its own pages, not what every object has", async () => {
  const s = server();
  for (const pane of ["toString", "__proto__", "constructor", "hasOwnProperty", "valueOf"]) await expect(s.mac.open(pane)).rejects.toMatchObject({ status: 400 });
  expect(s.ran).toEqual([]);
});

test("the program asking can be stopped from the phone: only that process, only while it's still that program, never macOS's own", async () => {
  // A real process standing in for the program asking.
  const proc = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  const run = async (args: string[]) => {
    const r = Bun.spawnSync(args, { stdout: "pipe", stderr: "ignore" });
    return { code: r.exitCode ?? 1, out: r.stdout.toString() };
  };
  try {
    const s = server({ run });
    void s.mac.start();
    s.line(prompting("5.1", HUB, "/bin/sleep", "kTCCServiceSystemPolicyDesktopFolder", "com.crosstalk.hub", proc.pid));
    const [d] = s.mac.dialogs();
    expect(d).toMatchObject({ app: "sleep (started by Crosstalk)", stoppable: true });
    expect(await s.mac.stopAsker(d.id)).toMatchObject({ dialogs: [] });
    expect(await proc.exited).not.toBe(0);
    // Gone already: said so, and the question stays listed for Dismiss, with no Stop for it now.
    s.line(prompting("6.1", HUB, "/bin/sleep", "kTCCServiceSystemPolicyDesktopFolder", "com.crosstalk.hub", proc.pid));
    await expect(s.mac.stopAsker(s.mac.dialogs()[0].id)).rejects.toMatchObject({ status: 409, code: "gone", message: expect.stringContaining("on Mac mini's screen") });
    expect(s.mac.dialogs()).toMatchObject([{ stoppable: false }]);
    // A number now used by another program, or a part of macOS (never offered): never stopped.
    const other = Bun.spawn(["/bin/sleep", "31"], { stdout: "ignore", stderr: "ignore" });
    s.line(prompting("7.1", HUB, "/usr/libexec/something", "kTCCServiceCamera", "com.crosstalk.hub", other.pid));
    s.line(prompting("8.1", HUB, "/Users/me/bin/tool", "kTCCServiceMicrophone", "com.crosstalk.hub", other.pid));
    expect(s.mac.dialogs().map((x) => [x.wants, x.stoppable])).toEqual([
      ["the Desktop folder", false],
      ["the camera", false],
      ["the microphone", true],
    ]);
    for (const x of s.mac.dialogs().filter((x) => x.wants !== "the Desktop folder")) await expect(s.mac.stopAsker(x.id)).rejects.toMatchObject({ status: 409 });
    expect(other.killed).toBe(false);
    expect(s.mac.dialogs().every((x) => !x.stoppable)).toBe(true);
    other.kill();
    s.mac.stop();
  } finally {
    proc.kill();
  }
});

test("Stop never ends a process that started after the program asked (its number reused), and goes once the program has exited", async () => {
  const proc = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  try {
    // What ps says of that number: it has run for 5 seconds, and its program.
    const s = server({
      run: async (args) => {
        s.ran.push(args);
        return args[0] === "/bin/ps" ? { code: 0, out: "   00:05 /bin/sleep\n" } : { code: 0, out: "" };
      },
    });
    void s.mac.start();
    // It asked a minute ago; the process with that number now has run for 5 seconds: another sleep, left alone.
    s.line(prompting("5.1", HUB, "/bin/sleep", "kTCCServiceSystemPolicyDesktopFolder", "com.crosstalk.hub", proc.pid, { processID: 169, timestamp: logTs(Date.now() - MINUTE) }));
    const [d] = s.mac.dialogs();
    expect(d.since).toBeLessThan(Date.now() - MINUTE + 1000);
    await expect(s.mac.stopAsker(d.id)).rejects.toMatchObject({ status: 409, code: "gone" });
    expect(s.ran).toContainEqual(["/bin/ps", "-o", "etime=", "-o", "comm=", "-p", String(proc.pid)]);
    await Bun.sleep(50);
    expect(proc.exitCode).toBeNull();
    // Nothing is left to stop for it, and the app is told: still listed for Dismiss, without Stop.
    expect(s.mac.dialogs()).toMatchObject([{ id: d.id, stoppable: false }]);
    expect(s.emitted.at(-1)).toMatchObject([{ id: d.id, stoppable: false }]);
    const looked = s.ran.length;
    await expect(s.mac.stopAsker(d.id)).rejects.toMatchObject({ status: 409, code: "gone" });
    expect(s.ran).toHaveLength(looked);
    // The program now given that number asks too (it started 5 seconds before): that's the one, stopped.
    s.line(prompting("6.1", HUB, "/bin/sleep", "kTCCServiceSystemPolicyDesktopFolder", "com.crosstalk.hub", proc.pid, { processID: 169 }));
    expect(s.mac.dialogs()).toMatchObject([{ id: d.id, count: 2, stoppable: true }]);
    expect(await s.mac.stopAsker(d.id)).toMatchObject({ dialogs: [] });
    expect(await proc.exited).not.toBe(0);
    s.mac.stop();
  } finally {
    proc.kill();
  }
  // A zombie with that number, or another user's program (signal 0 finds both): left alone, and no Stop after the first
  // try either. (The number is a process of the test's own, so nothing else could ever be signalled.)
  for (const out of ["   01:00 <defunct>\n", "   01:00 /usr/sbin/cupsd\n"]) {
    const other = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    try {
      const s = server({ run: async (args) => (args[0] === "/bin/ps" ? { code: 0, out } : { code: 0, out: "" }) });
      void s.mac.start();
      s.line(prompting("9.1", HUB, "/bin/sleep", "kTCCServiceSystemPolicyDesktopFolder", "com.crosstalk.hub", other.pid, { processID: 169, timestamp: logTs(Date.now() - 2 * MINUTE) }));
      await expect(s.mac.stopAsker(s.mac.dialogs()[0].id)).rejects.toMatchObject({ status: 409 });
      expect(s.mac.dialogs()).toMatchObject([{ stoppable: false }]);
      await Bun.sleep(20);
      expect(other.exitCode).toBeNull();
      s.mac.stop();
    } finally {
      other.kill();
    }
  }
  // A program that asked and has exited since: no Stop for it any more.
  let running = true;
  const s = server({ alive: () => running });
  void s.mac.start();
  s.line(prompting("9.1", HUB, "/bin/sleep", "kTCCServiceSystemPolicyDesktopFolder", "com.crosstalk.hub", 4242));
  expect(s.mac.dialogs()[0].stoppable).toBe(true);
  running = false;
  expect(s.mac.dialogs()[0].stoppable).toBe(false);
  expect((await s.mac.status()).dialogs[0].stoppable).toBe(false);
  s.mac.stop();
});

test("dialogs still waiting are kept when the hub restarts, and what tccd logged while it was off is read back, each once", async () => {
  const boot = Date.now() - 5 * HOUR;
  const run = async (args: string[]) => (args[0] === "/usr/sbin/sysctl" ? { code: 0, out: boottime(boot) } : { code: 0, out: "" });
  const kept = memory();
  const first = server({ run, ...kept, history: async () => [] });
  await first.mac.start();
  // Kept as it runs: the heartbeat, the boot it runs under, not stopped.
  expect(JSON.parse(kept.kept.text!)).toEqual({ heartbeat: expect.any(Number), boot, bootId: null, clean: false, waiting: [], crash: null });
  first.line(prompting("1.1", OLD, ADB, undefined, undefined, undefined, { processID: 169 }));
  await Bun.sleep(60);
  expect(first.notes).toHaveLength(1);
  first.line(python("2.1", "kTCCServiceSystemPolicyDownloadsFolder", { processID: 169 }));
  const downloads = first.mac.dialogs().find((d) => d.wants === "the Downloads folder")!;
  first.mac.stop();
  const saved = JSON.parse(kept.kept.text!);
  expect(saved).toMatchObject({ boot, clean: true, waiting: [{ app: "adb (started by an older Crosstalk)", notified: true, ids: ["169/1.1"] }, { app: "python3 (started by Crosstalk)", notified: false }] });

  // The hub starts again, the Mac didn't: adb's was answered meanwhile, python3 asked for the Desktop folder too, and the
  // stream (started before the log is read back) has that request again and a new one after it.
  const desktopAt = Date.now() - 2 * MINUTE;
  const asked = python("3.1", "kTCCServiceSystemPolicyDesktopFolder", { processID: 169, timestamp: logTs(desktopAt) }, 7002);
  const starts: string[] = [];
  const second = server({
    run,
    ...kept,
    history: async (start) => {
      starts.push(start);
      second.line(asked);
      second.line(python("4.1", "kTCCServiceSystemPolicyDocumentsFolder", { processID: 169, timestamp: logTs(Date.now()) }, 7003));
      return ["Filtering the log data…", result("1.1", 2, { processID: 169, timestamp: logTs(Date.now() - 3 * MINUTE) }), asked, '{"count":2,"finished":1}', ""];
    },
  });
  await second.mac.start();
  expect(starts).toEqual([logStart(saved.heartbeat - MINUTE)]);
  // The phone's note for adb's says it was answered; the rest are listed once each.
  expect(second.dropped).toEqual([{ tag: first.notes[0].tag, text: "Answered on Mac mini" }]);
  // Oldest first: the one from the log waits since it asked, before the kept one.
  const list = second.mac.dialogs();
  expect(list.map((d) => [d.wants, d.count])).toEqual([
    ["the Desktop folder", 1],
    ["the Downloads folder", 1],
    ["the Documents folder", 1],
  ]);
  expect(list[0].since).toBe(desktopAt);
  expect(list[1]).toEqual(downloads);
  // Those not told to the phone yet are told after the wait; adb's isn't told again.
  await Bun.sleep(60);
  expect(second.notes.map((n) => n.body.replace(/^python3 \(started by Crosstalk\) wants (.*?)\. .*$/, "$1")).sort()).toEqual(["the Desktop folder", "the Documents folder", "the Downloads folder"]);
  second.mac.stop();

  // Then the Mac restarted: no dialog outlives that, and the notes about them say so. The log is read from this boot on.
  const reboot = Date.now() - 20 * MINUTE;
  const starts2: string[] = [];
  const third = server({ run: async (args) => (args[0] === "/usr/sbin/sysctl" ? { code: 0, out: boottime(reboot) } : { code: 0, out: "" }), ...kept, history: async (start) => (starts2.push(start), []) });
  await third.mac.start();
  expect(third.mac.dialogs()).toEqual([]);
  expect(third.dropped.map((d) => d.text)).toEqual(["Gone: Mac mini restarted", "Gone: Mac mini restarted", "Gone: Mac mini restarted"]);
  expect(third.dropped.map((d) => d.tag).sort()).toEqual(second.notes.map((n) => n.tag).sort());
  expect(starts2).toEqual([logStart(reboot)]);
  // An ordinary restart (the hub stopped first): nothing to tell.
  expect(third.notes).toEqual([]);
  expect((await third.mac.status()).lastCrash).toBeNull();
  third.mac.stop();
});

test("a crash note that reached no phone (the network isn't back yet) is sent again, also to phones showing the app", async () => {
  const boot = Date.now() - HOUR;
  const at = boot - 15_000;
  const crashed = (tries: boolean[]) => {
    const calls: { tag: string; always?: boolean }[] = [];
    const s = server({
      run: async (args) => (args[0] === "/usr/sbin/sysctl" ? { code: 0, out: boottime(boot) } : args[0] === "/usr/sbin/system_profiler" ? { code: 0, out: USB } : { code: 0, out: "" }),
      ...memory(JSON.stringify({ heartbeat: at - 40_000, boot: boot - 3 * DAY, clean: false, waiting: [], crash: null })),
      files: (dir) => (dir === REPORTS ? [{ name: PANIC_FILE, mtime: boot + 7_000 }] : []),
      readText: (path) => (path === `${REPORTS}/${PANIC_FILE}` ? panicAt(at) : null),
      notify: async (n, opts) => {
        calls.push({ tag: n.tag, always: opts?.always });
        return tries.shift() ?? true;
      },
      noteRetryMs: 5,
    });
    return { s, calls };
  };
  // Two sends that reached no phone, then one that did: three in all, and no more.
  const a = crashed([false, false, true]);
  await a.s.mac.start();
  await Bun.sleep(150);
  expect(a.calls).toEqual([{ tag: "mac-crash", always: true }, { tag: "mac-crash", always: true }, { tag: "mac-crash", always: true }]);
  a.s.mac.stop();
  // Stopping the hub ends the tries.
  const b = crashed(Array(20).fill(false));
  await b.s.mac.start();
  await Bun.sleep(20);
  b.s.mac.stop();
  const sent = b.calls.length;
  await Bun.sleep(150);
  expect(b.calls.length).toBe(sent);
});

test("after a crash the phone is told once, This Mac shows it for a week, and Dismiss puts it away", async () => {
  // The Mac panicked (the report: a fault on a USB port), started up 15 seconds later, and Crosstalk only ran
  // again 7 hours on, when someone logged in.
  const boot = Date.now() - 7 * HOUR;
  const at = boot - 15_000;
  const kept = memory(JSON.stringify({ heartbeat: at - 40_000, boot: boot - 3 * DAY, clean: false, waiting: [], crash: null }));
  const ran: string[][] = [];
  const read: string[] = [];
  const deps: Partial<MacDeps> = {
    run: async (args) => {
      ran.push(args);
      if (args[0] === "/usr/sbin/sysctl") return { code: 0, out: boottime(boot) };
      if (args[0] === "/usr/sbin/system_profiler") return { code: 0, out: USB };
      if (args.at(-1) === "autoLoginUser") return { code: 1, out: "" };
      return { code: 0, out: "" };
    },
    ...kept,
    files: (dir) =>
      dir === REPORTS
        ? [
            { name: "ResetCounter-2026-05-14-024129.0003.diag", mtime: boot + 7_000 },
            { name: PANIC_FILE, mtime: boot + 7_000 },
            { name: "JetsamEvent-2026-05-13-181204.ips", mtime: boot - DAY },
          ]
        : [],
    readText: (path) => (read.push(path), path === `${REPORTS}/${PANIC_FILE}` ? panicAt(at) : null),
  };
  const s = server(deps);
  await s.mac.start();
  const crash = (await s.mac.status()).lastCrash!;
  expect(crash).toEqual({
    at,
    kind: "crash",
    cause: "a fault on a USB port",
    detail: expect.stringMatching(/^dart-usb1 \(0xfffffe1f8a3c4000\): DART\(DARTBLK\) error: SID 1 read protect exception on read of DVA .*…$/),
    devices: ["Portable SSD (Sabrent)", "Card Reader"],
    backAt: expect.any(Number),
    waitedMs: crash.backAt - boot,
  });
  expect(crash.detail!.length).toBeLessThanOrEqual(160);
  expect(crash.waitedMs).toBeGreaterThan(MAC_LOGIN_WAIT_MS);
  expect(s.notes).toEqual([{ title: "Mac mini crashed and restarted", body: `At ${clock(at)} (a fault on a USB port). Crosstalk was off until ${clock(crash.backAt)}: it waited at the login screen. Turn on automatic login in Settings → This Mac.`, tag: "mac-crash" }]);
  // Only the panic report was read, and only reading commands ran: the boot, the USB devices, automatic login, FileVault.
  expect(read).toEqual([`${REPORTS}/${PANIC_FILE}`]);
  expect(ran.slice(0, 4).map((a) => a.join(" "))).toEqual(["/usr/sbin/sysctl -n kern.boottime kern.bootsessionuuid", "/usr/sbin/system_profiler SPUSBHostDataType -json", "/usr/bin/defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser", "/usr/bin/fdesetup status"]);
  expect(ran.every((a) => ["/usr/sbin/sysctl", "/usr/sbin/system_profiler", "/usr/bin/defaults", "/usr/bin/fdesetup", "/usr/bin/pmset"].includes(a[0]) && !a.includes("write"))).toBe(true);
  s.mac.stop();

  // The hub restarts later under the same boot: still shown, not told again.
  const again = server(deps);
  await again.mac.start();
  expect((await again.mac.status()).lastCrash).toEqual(crash);
  expect(again.notes).toEqual([]);
  // Dismissed: gone, its notification with it, and still gone after the next restart.
  expect((await again.mac.dismissCrash()).lastCrash).toBeNull();
  expect(again.dropped).toEqual([{ tag: "mac-crash", text: "Dismissed" }]);
  again.mac.stop();
  const third = server(deps);
  await third.mac.start();
  expect((await third.mac.status()).lastCrash).toBeNull();
  third.mac.stop();

  // A week on, one that wasn't dismissed isn't shown either.
  const old = server({ ...deps, ...memory(JSON.stringify({ heartbeat: Date.now() - MINUTE, boot, clean: true, waiting: [], crash: { ...crash, at: Date.now() - 8 * DAY } })) });
  await old.mac.start();
  expect((await old.mac.status()).lastCrash).toBeNull();
  old.mac.stop();

  // On a Mac with FileVault on, which can't log in by itself, the phone isn't sent to turn on automatic login.
  const vault = server({
    ...deps,
    ...memory(JSON.stringify({ heartbeat: at - 40_000, boot: boot - 3 * DAY, clean: false, waiting: [], crash: null })),
    run: async (args) => (args[0] === "/usr/bin/fdesetup" ? { code: 0, out: "FileVault is On.\n" } : deps.run!(args)),
  });
  await vault.mac.start();
  const back = (await vault.mac.status()).lastCrash!.backAt;
  expect(vault.notes).toEqual([{ title: "Mac mini crashed and restarted", body: `At ${clock(at)} (a fault on a USB port). Crosstalk was off until ${clock(back)}: it waited at the login screen for its FileVault password.`, tag: "mac-crash" }]);
  vault.mac.stop();
});

test("a restart without a panic and without the hub stopping first was a power cut or a freeze; an ordinary one says nothing", async () => {
  const boot = Date.now() - MINUTE;
  const heartbeat = boot - 30 * MINUTE;
  const deps = (over: object, files: { name: string; mtime: number }[] = []): Partial<MacDeps> => ({
    run: async (args) => (args[0] === "/usr/sbin/sysctl" ? { code: 0, out: boottime(boot) } : { code: 0, out: "" }),
    ...memory(JSON.stringify({ heartbeat, boot: boot - 2 * DAY, clean: false, waiting: [], crash: null, ...over })),
    files: () => files,
    readText: () => panicAt(heartbeat - HOUR),
  });
  // A panic report from before the hub's last heartbeat is an older crash's: this one lost power (or froze).
  const power = server(deps({}, [{ name: PANIC_FILE, mtime: heartbeat - HOUR }]));
  await power.mac.start();
  const c = (await power.mac.status()).lastCrash!;
  expect(c).toEqual({ at: heartbeat, kind: "power", cause: null, detail: null, devices: [], backAt: expect.any(Number), waitedMs: c.backAt - boot });
  // It started again by itself within a minute: nothing about logging in.
  expect(power.notes).toEqual([{ title: "Mac mini restarted without shutting down", body: `Around ${clock(heartbeat)}: it may have lost power or frozen. Crosstalk was off until ${clock(c.backAt)}.`, tag: "mac-crash" }]);
  power.mac.stop();
  // The hub stopped first: an ordinary restart (an update, say).
  const clean = server(deps({ clean: true }));
  await clean.mac.start();
  expect((await clean.mac.status()).lastCrash).toBeNull();
  expect(clean.notes).toEqual([]);
  clean.mac.stop();
  // The Mac didn't restart (the hub did, or was ended): nothing about the Mac, a fresh panic report or not.
  const same = server({ ...deps({ boot }, [{ name: PANIC_FILE, mtime: Date.now() }]), readText: () => panicAt(Date.now() - MINUTE) });
  await same.mac.start();
  expect((await same.mac.status()).lastCrash).toBeNull();
  expect(same.notes).toEqual([]);
  same.mac.stop();
  // Each boot has its own id: one 40 seconds after the last (going down again and again) is told apart, and the same
  // boot with its time moved (the clock was set) is the same.
  const loop = (id: string, at: number) => server({ ...deps({ boot, bootId: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", heartbeat: boot + 30_000 }), run: async (args) => ({ code: 0, out: args[0] === "/usr/sbin/sysctl" ? `${boottime(at)}${id}\n` : "" }) });
  const again = loop("BBBBBBBB-CCCC-4DDD-8EEE-FFFFFFFFFFFF", boot + 40_000);
  await again.mac.start();
  expect((await again.mac.status()).lastCrash).toMatchObject({ kind: "power", at: boot + 30_000 });
  again.mac.stop();
  const moved = loop("AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", boot + 2 * MINUTE);
  await moved.mac.start();
  expect((await moved.mac.status()).lastCrash).toBeNull();
  moved.mac.stop();
});

test("the first run of this version shows a panic from just before this boot, without telling the phone", async () => {
  // Nothing kept yet. The Mac panicked 15 seconds before it started up 12 hours ago, and someone logged in 7 hours ago
  // (when the Dock started): an older Crosstalk ran from then.
  const boot = Date.now() - 12 * HOUR;
  const ps = ["  11:59:58 /usr/libexec/UserEventAgent", " 07:00:00 /System/Library/CoreServices/Dock.app/Contents/MacOS/Dock", "  06:59:59 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder", ""].join("\n");
  const deps = (panic: number): Partial<MacDeps> => ({
    run: async (args) => (args[0] === "/usr/sbin/sysctl" ? { code: 0, out: boottime(boot) } : args[0] === "/bin/ps" ? { code: 0, out: ps } : args[0] === "/usr/sbin/system_profiler" ? { code: 0, out: USB } : { code: 0, out: "" }),
    ...memory(),
    files: () => [{ name: PANIC_FILE, mtime: boot + 7_000 }],
    readText: () => panicAt(panic),
  });
  const s = server(deps(boot - 15_000));
  await s.mac.start();
  const c = (await s.mac.status()).lastCrash!;
  expect(c).toMatchObject({ at: boot - 15_000, kind: "crash", cause: "a fault on a USB port", devices: ["Portable SSD (Sabrent)", "Card Reader"] });
  expect(Math.abs(c.backAt - (Date.now() - 7 * HOUR))).toBeLessThan(5_000);
  expect(Math.abs(c.waitedMs - 5 * HOUR)).toBeLessThan(5_000);
  expect(s.notes).toEqual([]);
  s.mac.stop();
  // One from a day before this boot isn't this boot's.
  const older = server(deps(boot - DAY));
  await older.mac.start();
  expect((await older.mac.status()).lastCrash).toBeNull();
  older.mac.stop();
});

test("a panic's message in plain words, with its time from the kernel's clock", () => {
  // The fixture's: "Calendar: 0x6a0598b3 0x0005cc60" is 02:41:07.38 PDT, 15 seconds before the Mac started up again.
  const p = parsePanic(PANIC)!;
  expect(p.at).toBe(1778751667380);
  expect(p.panic).toStartWith('panic(cpu 0 caller 0xfffffe0031d27b58): "dart-usb1');
  // Without the clock line, the report's own time (written after the restart).
  expect(parsePanic(PANIC.replace(/Calendar: [^\\]*/, ""))!.at).toBe(Date.UTC(2026, 4, 14, 9, 41, 29));
  expect(parsePanic("not a report")).toBeNull();
  expect(parsePanic('{"bug_type":"210"}\n{ "panicString" : "cut short')).toBeNull();
  const usb = panicCause(p.panic);
  expect(usb).toEqual({ cause: "a fault on a USB port", detail: expect.stringMatching(/^dart-usb1 \(0xfffffe1f8a3c4000\): DART\(DARTBLK\) error: /), usbBus: 1 });
  expect(usb.detail).not.toContain("panic(cpu");
  const words = (first: string) => panicCause(`${first}\nDebugger message: panic\nOS version: 26A434`).cause;
  expect(words('panic(cpu 4 caller 0xfffffe0029abc12c): "dart-apcie1 (0xfffffe2122546000): DART(DARTBLK) error: SID 2"')).toBe("a hardware fault (apcie1)");
  expect(words("panic(cpu 1 caller 0xfffffe0029abc12c): watchdog timeout: no checkins from watchdogd in 90 seconds")).toBe("macOS stopped responding");
  expect(words('panic(cpu 0 caller 0xfffffe0029abc12c): "AppleSMC: thermal shutdown"')).toBe("it got too hot");
  expect(words("panic(cpu 2 caller 0xfffffe0029abc12c): Kernel data abort. at pc 0xfffffe0029abc12c")).toBe("a kernel panic");
  // Only the message counts, not the rest of the report (its loaded drivers, say).
  expect(panicCause("panic(cpu 2 caller 0x1): Kernel data abort.\ncom.apple.driver.AppleARMWatchdogTimer(1.0)").cause).toBe("a kernel panic");
  expect(panicCause("panic(cpu 2 caller 0x1): Kernel data abort.").detail).toBe("Kernel data abort.");
});

test("what's plugged into the USB port that faulted: a hub, then removable devices by name, their maker when it's a real name", () => {
  // An SSD and a card reader plugged straight in, on dart-usb1's bus (the card reader's maker, "Generic", isn't a name).
  expect(usbDevices(USB, 1)).toEqual(["Portable SSD (Sabrent)", "Card Reader"]);
  // A small dock on dart-usb3's bus (a USB 2 hub chip, and the Billboard chip announcing its video mode) with a flash
  // drive through it. The Billboard chip is part of the dock, not a device.
  expect(usbDevices(USB, 3)).toEqual(["a USB hub", "Flash Drive (Kingston)"]);
  // Only the Mac's own hubs there.
  expect(usbDevices(USB, 2)).toEqual([]);
  expect(usbDevices(USB, 7)).toEqual([]);
  expect(usbDevices("not json", 3)).toEqual([]);
  const one = (vendor: string, name = "Drive") => usbDevices(JSON.stringify({ SPUSBHostDataType: [{ USBKeyLocationID: "0x03000000", _items: [{ _name: name, USBDeviceKeyVendorName: vendor, USBKeyHardwareType: "Removable" }] }] }), 3);
  expect(one("Not Provided")).toEqual(["Drive"]);
  expect(one("0x0bc2")).toEqual(["Drive"]);
  expect(one("Samsung", "Samsung T7")).toEqual(["Samsung T7"]);
  expect(one("Apple Inc.", "USB-C Digital AV Multiport Adapter")).toEqual(["USB-C Digital AV Multiport Adapter (Apple Inc.)"]);
  expect(one("SanDisk")).toEqual(["Drive (SanDisk)"]);
});

test("the crash notification says when, why, and how long Crosstalk was off", () => {
  const back = new Date(2026, 4, 14, 9, 21).getTime();
  const crash = { at: new Date(2026, 4, 14, 2, 41, 7).getTime(), kind: "crash" as const, cause: "a fault on a USB port", detail: "dart-usb1", devices: [], backAt: back, waitedMs: 6 * HOUR + 40 * MINUTE };
  const manual = { autoLogin: null, fileVault: false };
  expect(crashNote(crash, NAME, manual, back)).toEqual({ title: "Mac mini crashed and restarted", body: "At 2:41 AM (a fault on a USB port). Crosstalk was off until 9:21 AM: it waited at the login screen. Turn on automatic login in Settings → This Mac." });
  // FileVault not known: as This Mac says it, automatic login is what to turn on.
  expect(crashNote(crash, NAME, { autoLogin: null, fileVault: null }, back).body).toEndWith(" Turn on automatic login in Settings → This Mac.");
  // Automatic login is on now: nothing to turn on.
  expect(crashNote(crash, NAME, { autoLogin: "jane", fileVault: false }, back).body).toBe("At 2:41 AM (a fault on a USB port). Crosstalk was off until 9:21 AM: it waited at the login screen.");
  // With FileVault on it can't log in by itself (there's no automatic login to turn on): it waited for the password.
  expect(crashNote(crash, NAME, { autoLogin: null, fileVault: true }, back).body).toBe("At 2:41 AM (a fault on a USB port). Crosstalk was off until 9:21 AM: it waited at the login screen for its FileVault password.");
  // It didn't wait.
  expect(crashNote({ ...crash, backAt: crash.at + 2 * MINUTE, waitedMs: MINUTE }, NAME, manual, back).body).toBe("At 2:41 AM (a fault on a USB port). Crosstalk was off until 2:43 AM.");
  expect(crashNote({ ...crash, backAt: crash.at + 2 * MINUTE, waitedMs: MINUTE }, NAME, { autoLogin: null, fileVault: true }, back).body).toBe("At 2:41 AM (a fault on a USB port). Crosstalk was off until 2:43 AM.");
  expect(crashNote({ ...crash, kind: "power", cause: null, detail: null, at: new Date(2026, 4, 13, 23, 50).getTime() }, NAME, manual, back)).toEqual({
    title: "Mac mini restarted without shutting down",
    body: "Around 11:50 PM yesterday: it may have lost power or frozen. Crosstalk was off until 9:21 AM: it waited at the login screen. Turn on automatic login in Settings → This Mac.",
  });
});

test("the hub runs only its own fixes in a terminal, and only on a Mac", async () => {
  const { App } = await import("../src/app");
  const { startServer } = await import("../src/server");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "ct-mac-fix-"));
  const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: root, maxHopsDefault: 6 } });
  await app.start();
  const server = startServer(app);
  try {
    const device = (await app.auth.pair((await app.auth.createPairingCode()).code, "Test", "Web"))!;
    const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${server.port}${path}`, { method: "POST", headers: { authorization: `Bearer ${device.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    // Anything but a known fix is refused before anything runs (nothing is started here: no sudo in tests), including
    // what every object has.
    for (const what of ["rm -rf /", "autologin; reboot", "", null, "toString", "__proto__", "constructor", "hasOwnProperty"]) {
      const r = await post("/api/mac/fix", { what });
      expect(r.status).toBe(process.platform === "darwin" ? 400 : 404);
    }
    expect(app.pty.list()).toEqual([]);
    expect((await post("/api/mac/open", { pane: "x-apple.systempreferences:anything" })).status).toBe(400);
    expect((await post("/api/mac/open", { pane: "toString" })).status).toBe(400);
    expect((await post("/api/mac/dialogs/nope/stop", {})).status).toBe(404);
    // The crash notice is put away from here (what This Mac reads is played: this Mac's own settings aren't read).
    app.mac.status = async () => ({ fullDiskAccess: null, autoLogin: null, fileVault: null, sleepMinutes: null, restartsAfterPowerCut: null, wakesForNetwork: null, autoUpdates: null, dialogs: [], lastCrash: null, checkedAt: Date.now() });
    const dismissed = await post("/api/mac/crash/dismiss", {});
    expect(dismissed.status).toBe(200);
    expect(await dismissed.json()).toMatchObject({ lastCrash: null });
  } finally {
    server.stop(true);
    await app.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the phone's fixes run through script(1), so sudo has a terminal to ask for the password in", async () => {
  const c = macFixCommand("autologin", "jane")!;
  expect(c.argv.slice(0, 4)).toEqual(["/usr/bin/script", "-q", "/dev/null", "/usr/bin/sudo"]);
  expect(c.argv.slice(4)).toEqual(["/usr/sbin/sysadminctl", "-autologin", "set", "-userName", "jane", "-password", "-"]);
  expect(macFixCommand("power", "jane")!.argv.slice(3)).toEqual(["/usr/bin/sudo", "/usr/bin/pmset", "-a", "sleep", "0", "autorestart", "1", "womp", "1"]);
  expect(macFixCommand("toString", "jane")).toBeNull();
  expect(macFixCommand("rm", "jane")).toBeNull();
  if (process.platform !== "darwin") return;
  // In the hub's kind of terminal (Bun's), a command has no controlling terminal (sudo needs one to ask), and through
  // script it has one.
  const opens = async (argv: string[]) => {
    let out = "";
    const term = new Bun.Terminal({ cols: 80, rows: 24, data: (_t: unknown, d: Uint8Array) => void (out += new TextDecoder().decode(d)) });
    const p = Bun.spawn([...argv, "/bin/sh", "-c", "(exec 3</dev/tty) 2>/dev/null && echo has-a-terminal || echo no-terminal"], { terminal: term, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
    await p.exited;
    await Bun.sleep(200);
    return out;
  };
  expect(await opens([])).toContain("no-terminal");
  expect(await opens(["/usr/bin/script", "-q", "/dev/null"])).toContain("has-a-terminal");
});
