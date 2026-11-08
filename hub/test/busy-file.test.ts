// RUN_DIR/busy.json (hub/src/busyFile.ts): what the hub is busy with that its database doesn't show, for the restart
// scripts (hub/test/restart-when-idle.test.ts runs those against it). Here the file goes to a temp folder of its own.

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@crosstalk/shared";
import { Bus } from "../src/bus";
import { BusyFile, type BusyEntry } from "../src/busyFile";

const dirs: string[] = [];
const files: BusyFile[] = [];
afterEach(() => {
  for (const f of files.splice(0)) f.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function busyFile(beatMs = 60_000) {
  const dir = mkdtempSync(join(tmpdir(), "ct-busy-"));
  dirs.push(dir);
  const path = join(dir, "busy.json");
  const bus = new Bus();
  let now: BusyEntry[] = [];
  const f = new BusyFile(path, () => now, (fn) => bus.on(fn), beatMs);
  files.push(f);
  const read = () => JSON.parse(readFileSync(path, "utf8"));
  return { f, path, bus, read, set: (list: BusyEntry[]) => (now = list) };
}

const job: BusyEntry = { roomId: "r1", memberId: "m1", why: "background" };
const tasks = { t: "tasks", roomId: "r1", memberId: "m1", tasks: [] } as ServerEvent;

test("written as the hub starts, again shortly after what's busy changes, and gone when it stops", async () => {
  const b = busyFile();
  // Count first, so the scripts read it with sed.
  expect(readFileSync(b.path, "utf8")).toStartWith('{"count":0,');
  expect(b.read()).toMatchObject({ count: 0, pid: process.pid, busy: [] });
  b.set([job]);
  b.bus.emit(tasks);
  b.bus.emit({ ...tasks });
  await Bun.sleep(700);
  expect(b.read()).toMatchObject({ count: 1, busy: [job] });
  // A burst of events with nothing changed writes nothing.
  const at = statSync(b.path).mtimeMs;
  await Bun.sleep(20);
  b.bus.emit({ t: "member", member: {} } as ServerEvent);
  await Bun.sleep(700);
  expect(statSync(b.path).mtimeMs).toBe(at);
  // Events that can't change it don't even look.
  b.set([]);
  b.bus.emit({ t: "spend", accounts: [] } as ServerEvent);
  await Bun.sleep(700);
  expect(b.read().count).toBe(1);
  b.f.stop();
  expect(existsSync(b.path)).toBe(false);
  // Stopped: nothing more is written.
  b.bus.emit(tasks);
  await Bun.sleep(700);
  expect(existsSync(b.path)).toBe(false);
});

test("rewritten every beat even when nothing changed, so a file that stops changing is a hub that stopped", async () => {
  const b = busyFile(150);
  const first = statSync(b.path).mtimeMs;
  await Bun.sleep(400);
  expect(statSync(b.path).mtimeMs).toBeGreaterThan(first);
  expect(b.read().count).toBe(0);
});

test("a hub that keeps nothing on disk writes nothing", () => {
  const bus = new Bus();
  const f = new BusyFile(null, () => [job], (fn) => bus.on(fn));
  files.push(f);
  bus.emit(tasks);
  f.write(true);
  f.stop();
});
