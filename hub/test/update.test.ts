// An update that applies itself (hub/src/update.ts): noticed, said, started when it's been quiet for two minutes, never
// over work by itself, at once when the person says so.

import { expect, test } from "bun:test";
import { updateWords } from "@crosstalk/shared";
import { QUIET_MS, Updater } from "../src/update";

function setup() {
  const t = { now: 1_000_000, staged: null as string | null, working: [] as string[], restarts: 0, said: 0 };
  const u = new Updater({ staged: async () => t.staged, working: () => t.working, restart: () => t.restarts++, changed: () => t.said++, now: () => t.now });
  const pass = async (ms: number) => {
    t.now += ms;
    await u.look();
  };
  return { t, u, pass };
}

test("nothing new in place: nothing to say, and it never restarts", async () => {
  const { t, u, pass } = setup();
  await pass(0);
  await pass(10 * QUIET_MS);
  expect(u.status()).toBeNull();
  expect([t.restarts, t.said]).toEqual([0, 0]);
});

test("a new build with nothing working starts once it has been quiet for two minutes, not before", async () => {
  const { t, u, pass } = setup();
  t.staged = "0.7.1";
  await pass(0);
  expect(u.status()).toMatchObject({ version: "0.7.1", working: 0, chats: [], restarting: false });
  expect(t.said).toBe(1);
  await pass(QUIET_MS - 1000);
  expect(t.restarts).toBe(0);
  await pass(1000);
  expect(t.restarts).toBe(1);
  expect(u.status()?.restarting).toBe(true);
  // Restarting: it doesn't ask twice.
  await pass(QUIET_MS);
  expect(t.restarts).toBe(1);
});

test("it waits for work however long that takes, says which chats, and the two minutes start again after each", async () => {
  const { t, u, pass } = setup();
  t.staged = "0.7.1";
  t.working = ["Fix login", "Release notes", "Importer", "Docs"];
  await pass(0);
  expect(u.status()).toMatchObject({ working: 4, chats: ["Fix login", "Release notes", "Importer"] });
  await pass(12 * 3600_000);
  expect(t.restarts).toBe(0);
  // Told again only when what the app shows changes.
  const said = t.said;
  await pass(30_000);
  expect(t.said).toBe(said);
  t.working = ["Fix login"];
  await pass(30_000);
  expect(t.said).toBe(said + 1);
  // Quiet for a minute, then a new message: the wait starts over.
  t.working = [];
  await pass(60_000);
  t.working = ["Fix login"];
  await pass(30_000);
  t.working = [];
  await pass(QUIET_MS - 1000);
  expect(t.restarts).toBe(0);
  await pass(QUIET_MS);
  expect(t.restarts).toBe(1);
});

test("Restart now starts it over work when the person asks, and says no when nothing waits", async () => {
  const { t, u, pass } = setup();
  expect(u.restartNow("Phone")).toBe(false);
  t.staged = "0.7.1";
  t.working = ["Fix login"];
  await pass(0);
  expect(u.restartNow("Phone")).toBe(true);
  expect(t.restarts).toBe(1);
  // A second tap while it restarts doesn't restart twice.
  expect(u.restartNow("Phone")).toBe(true);
  expect(t.restarts).toBe(1);
});

test("a build put back as it was is forgotten, and a newer one in its place starts the wait again", async () => {
  const { t, u, pass } = setup();
  t.staged = "0.7.1";
  await pass(0);
  await pass(60_000);
  t.staged = "0.7.2";
  await pass(30_000);
  expect(u.status()?.version).toBe("0.7.2");
  await pass(QUIET_MS - 1000);
  expect(t.restarts).toBe(0);
  t.staged = null;
  await pass(1000);
  expect(u.status()).toBeNull();
  await pass(10 * QUIET_MS);
  expect(t.restarts).toBe(0);
});

test("the words the app shows", () => {
  expect(updateWords({ version: "0.7.1", working: 0, restarting: false })).toBe("Update 0.7.1 is ready. It starts in a moment.");
  expect(updateWords({ version: "0.7.1", working: 1, restarting: false })).toBe("Update 0.7.1 is ready. It starts when the chat that's working is done.");
  expect(updateWords({ version: "0.7.1", working: 3, restarting: false })).toBe("Update 0.7.1 is ready. It starts when the 3 chats that are working are done.");
  expect(updateWords({ version: "0.7.1", working: 3, restarting: true })).toBe("Restarting to update to 0.7.1…");
});

// ---- where the new build is (setup/system.ts) ----

import { existsSync, mkdtempSync, readFileSync as read, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextBuildPath, stagedBuild, takeNextBuild } from "../src/setup/system";

test("a build waiting beside the running one is the update; it takes the running one's place only as the hub restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-next-"));
  try {
    const path = join(dir, "crosstalk-hub");
    writeFileSync(path, "the build that runs", { mode: 0o755 });
    // What each file says when asked its version.
    const versions: Record<string, string> = {};
    const asked: string[] = [];
    const run = async (args: string[]) => (asked.push(args[0]), versions[args[0]] ? { code: 0, out: `${versions[args[0]]}\n`, err: "" } : { code: 1, out: "", err: "not a program" });
    const staged = stagedBuild(run as never, path, true);
    // Nothing new: nothing is even run.
    expect(await staged()).toBeNull();
    expect(asked).toEqual([]);

    // Still being copied there (it doesn't run yet): no update yet.
    writeFileSync(nextBuildPath(path), "half a bu");
    expect(await staged()).toBeNull();
    // Whole: that's the update, and the running one hasn't moved.
    writeFileSync(nextBuildPath(path), "the new build", { mode: 0o755 });
    versions[nextBuildPath(path)] = "0.8.1";
    expect(await staged()).toBe("0.8.1");
    expect(read(path, "utf8")).toBe("the build that runs");

    // As the hub restarts: the new one is in place, the one that ran is kept beside it under its version.
    const was = statSync(path).ino;
    expect(takeNextBuild("0.8.0", path)).toBe(true);
    expect(read(path, "utf8")).toBe("the new build");
    expect(existsSync(nextBuildPath(path))).toBe(false);
    expect(read(`${path}.bak-0.8.0`, "utf8")).toBe("the build that runs");
    expect(statSync(`${path}.bak-0.8.0`).ino).toBe(was);
    // Nothing waits now.
    expect(takeNextBuild("0.8.0", path)).toBe(false);

    // The old way still counts (an installer puts the new build in place under a hub that runs): its version is the update.
    versions[path] = "0.8.1";
    expect(await staged()).toBe("0.8.1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("in development (the program is bun) nothing is looked for", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-next-"));
  try {
    const path = join(dir, "bun");
    writeFileSync(path, "bun");
    writeFileSync(nextBuildPath(path), "x");
    const run = async () => ({ code: 0, out: "9.9.9\n", err: "" });
    expect(await stagedBuild(run as never, path, false)()).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
