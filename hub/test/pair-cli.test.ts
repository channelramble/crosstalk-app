// `crosstalk-hub pair` prints a one-time code for a new device. The installers, the Linux setup command (machines.ts) and
// the Crosstalk Hub app read its "Pairing code: " line, and the app runs it as itself, so it must open nothing but the
// hub's data folder: no config.json written and no workspace folder made (macOS would ask about a protected one in the
// app's name). The CLI runs for real here, in a home of its own.

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "../src/auth";
import { Store } from "../src/db";

const MAIN = join(import.meta.dir, "../src/main.ts");
const dir = mkdtempSync(join(tmpdir(), "ct-pair-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("pair prints a code that pairs once, and touches only the data folder", async () => {
  const data = join(dir, "data");
  const workspaces = join(dir, "Documents", "crosstalk-workspaces");
  // Bun keeps its own cache of the transpiled source in the home folder; the compiled hub has none.
  const env = { HOME: join(dir, "home"), PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", CROSSTALK_HOME: data, CROSSTALK_WORKSPACES: workspaces };
  const done = Bun.spawnSync([process.execPath, MAIN, "pair", "5"], { env, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  const out = done.stdout.toString();
  expect(done.exitCode).toBe(0);
  expect(out).toMatch(/^Pairing code: [A-Z0-9]{4}-[A-Z0-9]{4} {2}\(valid until .+\)\n$/);
  expect(existsSync(workspaces)).toBe(false);
  expect(existsSync(join(data, "config.json"))).toBe(false);
  expect(existsSync(join(dir, "home"))).toBe(false);

  const store = new Store(join(data, "crosstalk.db"));
  try {
    const auth = new Auth(store);
    const code = out.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/)![0];
    expect(await auth.pair(code, "Phone", "Test")).not.toBeNull();
    expect(await auth.pair(code, "Phone", "Test")).toBeNull();
  } finally {
    store.close();
  }
});
