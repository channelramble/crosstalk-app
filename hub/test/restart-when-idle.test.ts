// deploy/restart-when-idle.sh restarts the installed hub only after five continuous idle minutes. 0.4's "Ask others" questions
// have no turn, so the script also reads the asks table; what the hub is busy with that its database doesn't show
// (background work, wake-ups agents owe) it reads from the hub's run/busy.json. deploy/restart-when-turns-end.sh (a restart
// asked for now) makes the same checks over 30 seconds. Here the scripts run for real against a temp database, with fake
// date, sleep, launchctl, systemctl, curl and the installed hub first on their PATH (and a fake uname for Linux): time is a
// counter that sleep advances, and "restarting" only writes a line. Nothing here can reach the real launchctl, the real
// hub (its port included) or ~/.crosstalk.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureAsks } from "../src/asks";
import { Store } from "../src/db";

const SCRIPT = join(import.meta.dir, "../../deploy/restart-when-idle.sh");
const NOW_SCRIPT = join(import.meta.dir, "../../deploy/restart-when-turns-end.sh");
const SQLITE = Bun.which("sqlite3");
const START = 1_800_000_000; // the fake clock's first second
const ms = (seconds: number) => seconds * 1000;

const dirs: string[] = [];
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Scenario {
  /** Rows of the asks table at the start (status, and when it was made and ended, in seconds on the fake clock); omitted: no asks table at all. */
  asks?: { status: string; created: number; ended?: number }[];
  /** SQL run inside the Nth sleep (@NOW@ is the fake clock in ms), like something finishing while the script waits. */
  hooks?: Record<number, string>;
  /** The script is ended by its Nth sleep, so a hub that never goes idle can't loop. */
  maxSleeps?: number;
  /** What `uname -s` says: Linux restarts the systemd user service instead of the LaunchAgent. */
  os?: "Linux";
  /** The hub's data in a folder of its own, given as CROSSTALK_HOME, while ~/.crosstalk holds a busy hub's database. */
  dataHome?: boolean;
  /** More environment for the script (CROSSTALK_LABEL, CROSSTALK_UNIT, and FAKE_STOPPED: the unit isn't active). */
  env?: Record<string, string>;
  /** The hub's run/busy.json at the start: what it lists, and how many minutes ago the hub last wrote it. */
  busy?: { count: number; minutesAgo?: number };
  /** busy.json as the hub writes it inside the Nth sleep: what it lists (null: the hub removed it, as it does stopping). */
  busyHooks?: Record<number, number | null>;
  /** deploy/restart-when-turns-end.sh instead: a restart asked for now. */
  now?: boolean;
}

/** What the hub writes (hub/src/busyFile.ts), for a count. */
const busyBody = (count: number) => JSON.stringify({ count, pid: 4242, at: 0, busy: Array.from({ length: count }, (_, i) => ({ roomId: `r${i}`, memberId: `m${i}`, why: "background" })) }) + "\n";

function run(s: Scenario) {
  const home = temp("ct-idle-home-");
  const bin = temp("ct-idle-bin-");
  const state = temp("ct-idle-state-");
  mkdirSync(join(home, ".crosstalk"));
  const dataHome = s.dataHome ? temp("ct-idle-data-") : null;
  const dbPath = join(dataHome ?? join(home, ".crosstalk"), "crosstalk.db");
  if (dataHome) {
    // The default folder's hub is busy for good: restarting at all shows the script read CROSSTALK_HOME's instead.
    const decoy = new Store(join(home, ".crosstalk", "crosstalk.db"));
    ensureAsks(decoy.db);
    decoy.db.query("INSERT INTO asks (id, room_id, message_id, provider, account, label, status, created_at) VALUES ('busy', 'r', 'm', 'codex', 'default', 'Codex', 'running', ?)").run(ms(START));
    decoy.close();
  }
  // The hub's own schema (so the script's turns and members queries are the real ones), and the asks table when this hub has 0.4.
  const store = new Store(dbPath);
  if (s.asks) {
    ensureAsks(store.db);
    s.asks.forEach((a, i) =>
      store.db
        .query("INSERT INTO asks (id, room_id, message_id, provider, account, label, status, created_at, started_at, ended_at) VALUES (?, 'r', 'm', 'codex', 'default', 'Codex', ?, ?, ?, ?)")
        .run(`ask_${i}`, a.status, ms(a.created), a.status === "queued" ? null : ms(a.created), a.ended ? ms(a.ended) : null),
    );
  }
  store.close();
  const busyFile = join(dirname(dbPath), "run", "busy.json");
  mkdirSync(dirname(busyFile), { recursive: true });
  if (s.busy) {
    writeFileSync(busyFile, busyBody(s.busy.count));
    const at = (Date.now() - (s.busy.minutesAgo ?? 0) * 60_000) / 1000;
    utimesSync(busyFile, at, at);
  }
  for (const [n, count] of Object.entries(s.busyHooks ?? {})) writeFileSync(join(state, `busy-${n}`), count === null ? "" : busyBody(count));
  writeFileSync(join(state, "clock"), String(START));
  writeFileSync(join(state, "sleeps"), "0");
  for (const [n, sql] of Object.entries(s.hooks ?? {})) writeFileSync(join(state, `hook-${n}`), sql);
  const tool = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  tool("date", `if [ "$1" = "+%s" ]; then cat "$FAKE_STATE/clock"; else echo "a fake time"; fi`);
  tool("launchctl", `echo "$* sleeps=$(cat "$FAKE_STATE/sleeps")" >> "$FAKE_STATE/launchctl.log"`);
  tool("systemctl", `if [ "$2" = "is-active" ]; then [ -z "$FAKE_STOPPED" ]; exit; fi\necho "$* sleeps=$(cat "$FAKE_STATE/sleeps")" >> "$FAKE_STATE/systemctl.log"`);
  if (s.os === "Linux") tool("uname", `if [ "$1" = "-s" ]; then echo Linux; else /usr/bin/uname "$@"; fi`);
  tool(
    "sleep",
    [
      `n=$(( $(cat "$FAKE_STATE/sleeps") + 1 ))`,
      `echo "$n" > "$FAKE_STATE/sleeps"`,
      `echo $(( $(cat "$FAKE_STATE/clock") + $1 )) > "$FAKE_STATE/clock"`,
      `if [ -f "$FAKE_STATE/hook-$n" ]; then`,
      `  now=$(( $(cat "$FAKE_STATE/clock") * 1000 ))`,
      `  sqlite3 "\${CROSSTALK_HOME:-$HOME/.crosstalk}/crosstalk.db" "$(sed "s/@NOW@/$now/g" "$FAKE_STATE/hook-$n")"`,
      `fi`,
      `if [ -f "$FAKE_STATE/busy-$n" ]; then`,
      `  if [ -s "$FAKE_STATE/busy-$n" ]; then cat "$FAKE_STATE/busy-$n" > "$FAKE_BUSY"; else rm -f "$FAKE_BUSY"; fi`,
      `fi`,
      `[ "$n" -lt "$FAKE_MAX_SLEEPS" ] || kill "$PPID"`,
    ].join("\n"),
  );
  // After a restart asked for now, the script asks the hub's health for its version: the one installed comes back.
  tool("curl", `echo "$*" >> "$FAKE_STATE/curl.log"\necho '{"ok":true,"version":"0.6.5"}'`);
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(join(home, ".local", "bin", "crosstalk-hub"), `#!/bin/sh\n[ "$1" = version ] && echo 0.6.5\n`);
  chmodSync(join(home, ".local", "bin", "crosstalk-hub"), 0o755);
  const PATH = `${bin}:${dirname(SQLITE!)}:/usr/bin:/bin`;
  // The fakes must win, or the script would restart the real hub (or ask it how it is).
  expect(Bun.which("launchctl", { PATH })).toBe(join(bin, "launchctl"));
  expect(Bun.which("systemctl", { PATH })).toBe(join(bin, "systemctl"));
  expect(Bun.which("sleep", { PATH })).toBe(join(bin, "sleep"));
  expect(Bun.which("curl", { PATH })).toBe(join(bin, "curl"));
  const log = join(state, "restart.log");
  // Never the live hub's port, even through the fake.
  const env = { PATH, HOME: home, FAKE_STATE: state, FAKE_BUSY: busyFile, FAKE_MAX_SLEEPS: String(s.maxSleeps ?? 60), CROSSTALK_PORT: "9", CROSSTALK_RESTART_LOG: log, ...(dataHome ? { CROSSTALK_HOME: dataHome } : {}), ...s.env };
  const done = Bun.spawnSync(["/bin/sh", s.now ? NOW_SCRIPT : SCRIPT], { env, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  const lines = (name: string) => (existsSync(join(state, name)) ? readFileSync(join(state, name), "utf8").trim().split("\n") : []);
  return { restarts: lines("launchctl.log"), systemd: lines("systemctl.log"), curls: lines("curl.log"), said: lines("restart.log"), sleeps: Number(readFileSync(join(state, "sleeps"), "utf8")), exit: done.exitCode, out: done.stdout.toString() };
}

describe.skipIf(!SQLITE)("deploy/restart-when-idle.sh", () => {
  test("a hub from before 0.4 (no asks table) is restarted after five idle minutes, as it always was", () => {
    const r = run({});
    expect(r.restarts).toEqual(["kickstart -k gui/" + process.getuid!() + "/com.crosstalk.hub sleeps=5"]);
    expect(r.systemd).toEqual([]);
    expect(r.exit).toBe(0);
  });

  test("CROSSTALK_LABEL names another LaunchAgent to restart", () => {
    const r = run({ env: { CROSSTALK_LABEL: "com.crosstalk.hub.test" } });
    expect(r.restarts).toEqual(["kickstart -k gui/" + process.getuid!() + "/com.crosstalk.hub.test sleeps=5"]);
  });

  test("on Linux it restarts the systemd user service, never launchctl", () => {
    const r = run({ os: "Linux" });
    expect(r.systemd).toEqual(["--user restart crosstalk-hub sleeps=5"]);
    expect(r.restarts).toEqual([]);
    expect(r.exit).toBe(0);
  });

  test("on Linux CROSSTALK_UNIT names another unit", () => {
    const r = run({ os: "Linux", env: { CROSSTALK_UNIT: "crosstalk-hub-test" } });
    expect(r.systemd).toEqual(["--user restart crosstalk-hub-test sleeps=5"]);
  });

  test("on Linux a hub that was stopped meanwhile stays stopped (systemctl restart would start it)", () => {
    const r = run({ os: "Linux", env: { FAKE_STOPPED: "1" } });
    expect(r.systemd).toEqual([]);
    expect(r.out).toContain("hub isn't running (stopped meanwhile?); not restarted");
    expect(r.exit).toBe(0);
  });

  test("it reads the database in CROSSTALK_HOME, as the hub does, not ~/.crosstalk", () => {
    const r = run({ dataHome: true, hooks: { 2: "insert into turns (id, room_id, member_id, chain_id, status, created_at, started_at, ended_at) values ('t_quick', 'r', 'm', 'c', 'done', @NOW@, @NOW@, @NOW@)" } });
    // ~/.crosstalk's hub never goes idle; the one in CROSSTALK_HOME does, five minutes after its turn in the 2nd sleep.
    expect(r.restarts).toHaveLength(1);
    expect(r.sleeps).toBe(7);
  });

  test("a chat waiting for a usage limit counts as idle: a deploy isn't held up for hours", () => {
    // Its wait is in the database (Turn.wait), so it still carries on after the restart; nothing is running meanwhile.
    const r = run({ hooks: { 1: "insert into turns (id, room_id, member_id, chain_id, status, error, wait, created_at, started_at) values ('t_wait', 'r', 'm', 'c', 'waiting', 'out of messages', '{\"provider\":\"claude\"}', @NOW@, @NOW@)" } });
    expect(r.restarts).toHaveLength(1);
    expect(r.sleeps).toBe(6); // the insert in the 1st sleep moved the clock, nothing more
  });

  test("an asks table with nothing waiting or running changes nothing", () => {
    const r = run({ asks: [{ status: "done", created: START - 7200, ended: START - 7100 }, { status: "error", created: START - 7200, ended: START - 7100 }] });
    expect(r.restarts).toHaveLength(1);
    expect(r.sleeps).toBe(5);
  });

  test("a running ask and a queued ask keep it busy; five idle minutes after the last one ends it restarts", () => {
    const r = run({
      asks: [
        { status: "running", created: START - 30 },
        { status: "queued", created: START - 20 },
      ],
      // The running one ends in the 10th sleep (ten minutes in), the queued one (which then ran) in the 12th.
      hooks: { 10: "update asks set status = 'done', ended_at = @NOW@ where id = 'ask_0'", 12: "update asks set status = 'done', ended_at = @NOW@ where id = 'ask_1'" },
    });
    expect(r.restarts).toHaveLength(1);
    // Not before ten minutes, nor within five of the second one ending (the 12th sleep): idle from the 12th, restarted on the 17th.
    expect(r.sleeps).toBe(17);
  });

  test("an ask that starts and ends between two checks still restarts the idle clock", () => {
    const r = run({
      asks: [],
      // Made and finished inside the 3rd sleep: the next check sees nothing running, but something happened just now.
      hooks: { 3: "insert into asks (id, room_id, message_id, provider, account, label, status, created_at, started_at, ended_at) values ('quick', 'r', 'm', 'codex', 'default', 'Codex', 'done', @NOW@, @NOW@, @NOW@)" },
    });
    expect(r.restarts).toHaveLength(1);
    expect(r.sleeps).toBe(8); // five idle minutes from the 3rd sleep, not from the start (which would be the 5th)
  });

  test("a hub that never goes idle is never restarted", () => {
    const r = run({ asks: [{ status: "running", created: START - 30 }], maxSleeps: 12 });
    expect(r.restarts).toEqual([]);
    expect(r.sleeps).toBe(12);
    expect(r.exit).not.toBe(0); // ended by the fake sleep, not by restarting
  });

  test("an unreadable asks table counts as busy, not as idle", () => {
    // A table that exists but isn't the one Crosstalk makes (no status column): the check can't tell, so it waits.
    const r = run({ asks: [], hooks: { 1: "drop table asks; create table asks (x text)" }, maxSleeps: 10 });
    expect(r.restarts).toEqual([]);
  });

  test("background work the hub says it runs (busy.json) holds the restart; five idle minutes after it's done, it restarts", () => {
    // A 30-minute test suite Claude Code runs in the background writes to its own output file, not the transcript, and no
    // turn runs meanwhile: before busy.json the watcher restarted the hub under it, ending the job and the wake-up after it.
    const r = run({ busy: { count: 1 }, busyHooks: { 4: 0 } });
    expect(r.restarts).toEqual(["kickstart -k gui/" + process.getuid!() + "/com.crosstalk.hub sleeps=9"]);
  });

  test("a hub that never stops being busy with background work is never restarted", () => {
    const r = run({ busy: { count: 2 }, maxSleeps: 12 });
    expect(r.restarts).toEqual([]);
    expect(r.sleeps).toBe(12);
  });

  test("a busy.json the hub hasn't rewritten for three minutes is from a hub that isn't running: it says nothing", () => {
    const r = run({ busy: { count: 2, minutesAgo: 10 } });
    expect(r.restarts).toEqual(["kickstart -k gui/" + process.getuid!() + "/com.crosstalk.hub sleeps=5"]);
  });

  test("a busy.json the hub took away (it stopped) holds nothing", () => {
    const r = run({ busy: { count: 1 }, busyHooks: { 2: null } });
    expect(r.restarts).toEqual(["kickstart -k gui/" + process.getuid!() + "/com.crosstalk.hub sleeps=7"]);
  });
});

describe.skipIf(!SQLITE)("deploy/restart-when-turns-end.sh (a restart asked for now)", () => {
  test("the same checks over 30 seconds: a running ask and the hub's background work hold it, then it restarts and says the installed version came back", () => {
    const r = run({
      now: true,
      asks: [{ status: "running", created: START - 30 }],
      // The ask ends in the 3rd look (15 s in), the hub's background job in the 5th (25 s in): 30 quiet seconds from there.
      hooks: { 3: "update asks set status = 'done', ended_at = @NOW@ where id = 'ask_0'" },
      busy: { count: 1 },
      busyHooks: { 5: 0 },
    });
    expect(r.restarts).toEqual(["kickstart -k gui/" + process.getuid!() + "/com.crosstalk.hub sleeps=11"]);
    expect(r.said).toEqual(["a fake time restarting hub now (asked for), idle for 30 seconds", "a fake time hub is back: 0.6.5"]);
    // Its health is asked on the port the hub was given (never the live hub's in a test).
    expect(r.curls).toEqual(["-s --max-time 2 http://127.0.0.1:9/api/health"]);
    expect(r.exit).toBe(0);
  });

  test("a hub from before 0.4 (no asks table, no busy.json) is restarted after 30 idle seconds", () => {
    const r = run({ now: true });
    expect(r.restarts).toEqual(["kickstart -k gui/" + process.getuid!() + "/com.crosstalk.hub sleeps=6"]);
    expect(r.exit).toBe(0);
  });

  test("on Linux it restarts the systemd user service", () => {
    const r = run({ now: true, os: "Linux" });
    expect(r.systemd).toEqual(["--user restart crosstalk-hub sleeps=6"]);
    expect(r.restarts).toEqual([]);
  });

  test("background work that never ends keeps it waiting: it doesn't restart", () => {
    const r = run({ now: true, busy: { count: 1 }, maxSleeps: 20 });
    expect(r.restarts).toEqual([]);
    expect(r.systemd).toEqual([]);
  });
});
