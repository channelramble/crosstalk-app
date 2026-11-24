#!/usr/bin/env bun
// The hub's tests for a shared CI machine: `bun hub/scripts/test-ci.ts [files…]`.
// A few tests drive real processes against the clock, and on a busy shared runner one of them now and then loses a
// race it wins everywhere else. So a failure has to happen twice to count: the files with a failed test run once
// more, alone. What failed only the first time is still named, as a warning, so it doesn't go unseen.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hub = join(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "crosstalk-test-ci-"));
const report = join(dir, "first.xml");

async function run(args: string[]): Promise<number> {
  const p = Bun.spawn(["bun", "test", ...args], { cwd: hub, stdio: ["ignore", "inherit", "inherit"] });
  return p.exited;
}

/** The test files with a failed (or errored) test in a JUnit report. */
export function failedFiles(xml: string): string[] {
  const out = new Set<string>();
  for (const m of xml.matchAll(/<testsuite\b([^>]*)>/g)) {
    const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(m[1])?.[1] ?? "";
    const file = attr("file") || attr("name");
    if ((Number(attr("failures")) > 0 || Number(attr("errors")) > 0) && /\.test\.[cm]?[jt]sx?$/.test(file)) out.add(file);
  }
  return [...out];
}

if (import.meta.main) {
  const first = await run([...process.argv.slice(2), "--reporter=junit", `--reporter-outfile=${report}`]);
  if (first === 0) {
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  }
  let files: string[] = [];
  try {
    files = failedFiles(readFileSync(report, "utf8"));
  } catch {
    // No report: the run died before it could write one. That is a failure as it stands.
  }
  rmSync(dir, { recursive: true, force: true });
  if (!files.length) {
    console.error("\nThe tests failed, and no report says which: not run again.");
    process.exit(first);
  }
  console.error(`\nFailed the first time: ${files.join(", ")}. Running ${files.length === 1 ? "it" : "them"} once more, alone.\n`);
  const again = await run(files);
  if (again === 0) console.log(`::warning::Failed once and passed when run again (sensitive to timing): ${files.join(", ")}`);
  process.exit(again);
}
