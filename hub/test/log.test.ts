// The hub's log lines (util/log.ts) and the Mac log's size (setup/system.ts rotateLog).
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateLog } from "../src/setup/system";
import { stamp } from "../src/util/log";

test("a log line's time is the machine's own date and time, to the millisecond", () => {
  expect(stamp(new Date(2026, 10, 2, 8, 5, 9, 7))).toBe("2026-11-02 08:05:09.007");
  expect(stamp(new Date(2026, 0, 31, 23, 59, 59, 999))).toBe("2026-01-31 23:59:59.999");
});

test("the log starts over past its size, keeping what was there beside it; a small one is left alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-log-"));
  try {
    const path = join(dir, "hub.log");
    writeFileSync(path, "short\n");
    expect(rotateLog(path, 100)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("short\n");
    writeFileSync(path, "x".repeat(200));
    expect(rotateLog(path, 100)).toBe(true);
    expect(statSync(path).size).toBe(0);
    expect(readFileSync(`${path}.1`, "utf8")).toBe("x".repeat(200));
    // No log at all (Linux, or run by hand): nothing to do.
    expect(rotateLog(join(dir, "none.log"), 100)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
