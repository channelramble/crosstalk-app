import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, installScript } from "./fixtures/pool-fakes";
import { currentTest, endStarted, noted, running, testOf, testsOf } from "./standins";

// The check that no hub test leaves a process running (standins.ts, which preload.ts installs around every test), and
// the stand-in servers in fixtures/ ending by themselves once whoever started them has gone.

const FIXTURES = join(import.meta.dir, "fixtures");
const dirs: string[] = [];
/** Processes something else started (a nested run, a stand-in's starter), so nothing notes them: ended after each test. */
const elsewhere: number[] = [];

afterEach(async () => {
  for (const pid of elsewhere.splice(0)) for (const target of [-pid, pid]) signal(target);
  await endStarted();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function signal(target: number) {
  try {
    process.kill(target, "SIGKILL");
  } catch {
    // Ended.
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(done: () => boolean, ms: number) {
  const stop = Date.now() + ms;
  while (!done() && Date.now() < stop) await Bun.sleep(25);
  return done();
}
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-standins-"));
  dirs.push(dir);
  return dir;
};
const IDLE = "setInterval(() => {}, 60_000)";

test("every process a test starts is noted, node:child_process's too, with what it runs and the line that started it", async () => {
  const grouped = spawn(process.execPath, ["-e", IDLE], { detached: true, stdio: "ignore" });
  grouped.unref();
  const plain = Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  const mine = noted().filter((s) => s.test === currentTest());
  expect(mine.map((s) => [s.pid, s.group])).toEqual([
    [grouped.pid!, true],
    [plain.pid, false],
  ]);
  expect(mine[0]).toMatchObject({ command: `${process.execPath} -e ${IDLE}`, cwd: process.cwd(), from: expect.stringMatching(/^hub\/test\/standins\.test\.ts:\d+$/) });
  // What a test file's afterEach calls: all of it ends, and is waited for.
  await endStarted();
  expect(mine.some(running)).toBe(false);
  expect(alive(grouped.pid!)).toBe(false);
  expect(plain.signalCode).toBe("SIGKILL");
});

test("a test that leaves a process group running fails, a run that leaves anything fails, and all of it is ended", async () => {
  const dir = folder();
  // Each process the tests below start says this, so whatever the check missed can be found and ended here.
  const mark = `ct-standins-${crypto.randomUUID()}`;
  const idle = `${IDLE} // ${mark}`;
  writeFileSync(
    join(dir, "leaky.test.ts"),
    `import { test } from "bun:test";
import { spawn } from "node:child_process";
const idle = ${JSON.stringify(idle)};
test("leaves a server in a process group of its own", () => {
  spawn(process.execPath, ["-e", idle], { detached: true, stdio: "ignore" }).unref();
});
test("leaves what a server started in its group, once the server itself has gone", async () => {
  const starts = \`require("node:child_process").spawn(process.execPath, ["-e", \${JSON.stringify(idle)}], { stdio: "ignore" }); setTimeout(() => process.exit(0), 100)\`;
  const leader = spawn(process.execPath, ["-e", starts], { detached: true, stdio: "ignore" });
  await new Promise((done) => leader.on("exit", done));
});
test("ends what it started", async () => {
  const p = Bun.spawn([process.execPath, "-e", idle]);
  p.kill();
  await p.exited;
});
test("leaves a plain child", () => {
  Bun.spawn([process.execPath, "-e", idle], { stdout: "ignore", stderr: "ignore" });
});
`,
  );
  try {
    // A run of its own (the folder has no bunfig.toml), with the hub tests' preload: the real hooks, around real tests.
    const run = Bun.spawn([process.execPath, "test", "--preload", join(import.meta.dir, "preload.ts"), "./leaky.test.ts"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()]);
    const said = out + err;
    expect(await run.exited).toBe(1);
    expect(said).toContain("(fail) leaves a server in a process group of its own");
    expect(said).toContain("(fail) leaves what a server started in its group, once the server itself has gone");
    expect(said.match(/This test left a process group running, and `bun test` never ends one \(ended now\):\n {2}pid \d+ \(its own process group\): `.+` in .+, started at .+leaky\.test\.ts:\d+/g)).toHaveLength(2);
    expect(said).toMatch(/The run left a process running, which `bun test` doesn't end \(ended now\):\n {2}pid \d+: `.+ -e setInterval\(\(\) => \{\}, 60_000\) \/\/ ct-standins-[^`]+` in .+, started at .+leaky\.test\.ts:\d+; running: /);
    expect(said).toMatch(/ 2 pass\n 3 fail\n/);
  } finally {
    // Nothing it started is left: not the two process groups, nor the plain child `bun test` would have left behind.
    const left = Bun.spawnSync(["pgrep", "-f", mark]).stdout.toString().split(/\s+/).map(Number).filter(Boolean);
    elsewhere.push(...left);
    expect(left).toEqual([]);
  }
}, 30_000);

test("what a timed-out test's code starts after its time is up is laid at that test's door, not the next one's", async () => {
  const dir = folder();
  const mark = `ct-standins-${crypto.randomUUID()}`;
  const idle = `${IDLE} // ${mark}`;
  // A test that times out goes on in the background (bun can't stop it): here it starts a server in a process group of
  // its own half a second after its time was up, while the next test runs. That one, a test of another file running
  // meanwhile, and the file's last test don't fail for it; the run does, naming the test whose code it was.
  writeFileSync(
    join(dir, "late.test.ts"),
    `import { test } from "bun:test";
import { spawn } from "node:child_process";
const idle = ${JSON.stringify(idle)};
test("first", () => {});
test("times out, and starts a server late", async () => {
  await new Promise((done) => setTimeout(done, 800));
  spawn(process.execPath, ["-e", idle], { detached: true, stdio: "ignore" }).unref();
}, 300);
test("a later test", async () => {
  await new Promise((done) => setTimeout(done, 1200));
});
test("one that leaves its own", () => {
  spawn(process.execPath, ["-e", idle], { detached: true, stdio: "ignore" }).unref();
});
`,
  );
  try {
    const run = Bun.spawn([process.execPath, "test", "--preload", join(import.meta.dir, "preload.ts"), "./late.test.ts"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()]);
    const said = out + err;
    expect(await run.exited).toBe(1);
    expect(said).toContain("(fail) times out, and starts a server late");
    expect(said).not.toContain("(fail) a later test");
    // Its own is still its own.
    expect(said).toContain("(fail) one that leaves its own");
    expect(said.match(/This test left a process group running/g)).toHaveLength(1);
    expect(said).toMatch(/started a process group after its test ended, while another ran \(ended then, and not blamed on that one\):\n {2}the test "times out, and starts a server late" \(\/.*\/late\.test\.ts:5\), after it had ended \(one that timed out goes on running\):\n {2}pid \d+ \(its own process group\): `.+` in .+, started at \/.*\/late\.test\.ts:7/);
    // First and the later one pass; the one that timed out, the one that left its own, and the run fail.
    expect(said).toMatch(/ 2 pass\n 3 fail\n/);
  } finally {
    const left = Bun.spawnSync(["pgrep", "-f", mark]).stdout.toString().split(/\s+/).map(Number).filter(Boolean);
    elsewhere.push(...left);
    expect(left).toEqual([]);
  }
}, 30_000);

test("the tests a file writes, in order, with the lines each body takes, and whether the n-th to run is the n-th written", () => {
  const dir = folder();
  const plain = join(dir, "plain.test.ts");
  writeFileSync(
    plain,
    [
      'import { describe, test } from "bun:test";',
      'test("one", () => {',
      "  const x = 1;",
      "});",
      "function helper() {",
      "  return 1;",
      "}",
      'describe("group", () => {',
      '  test("two", async () => {});',
      "  test(",
      '    "three",',
      "    async () => {",
      "      helper();",
      "    },",
      "  );",
      "});",
      "",
    ].join("\n"),
  );
  const odd = join(dir, "odd.test.ts");
  writeFileSync(odd, ['import { test } from "bun:test";', 'test.skip("skipped", () => {});', 'for (const n of [1, 2]) test(`made ${n}`, () => {});', ""].join("\n"));
  expect(testsOf(plain)).toEqual({
    tests: [
      { file: plain, place: 1, name: "one", line: 2 },
      { file: plain, place: 2, name: "two", line: 9 },
      { file: plain, place: 3, name: "three", line: 10 },
    ],
    ends: [4, 9, 15],
    inOrder: true,
  });
  expect(testsOf(odd)?.inOrder).toBe(false);
  // A line in a test's body names it (the innermost such line of a stack); a helper between tests, or another file, none.
  expect(testOf([`/elsewhere/helper.ts:3`, `${plain}:3`])?.name).toBe("one");
  expect(testOf([`${plain}:6`, `${plain}:13`])?.name).toBe("three");
  expect(testOf([`${plain}:6`])).toBeNull();
  expect(testOf([`/elsewhere/helper.ts:3`])).toBeNull();
});

test("the stand-in servers end by themselves once whoever started them has gone, as after a test run that was killed", async () => {
  const dir = folder();
  // As far as a stand-in can tell, a test run: it starts the server in a process group of its own, as start.sh and Local
  // models do, then waits until it's killed.
  writeFileSync(
    join(dir, "run.ts"),
    `import { spawn } from "node:child_process";
const { argv, env } = JSON.parse(process.argv[2]);
spawn(process.execPath, argv, { cwd: ${JSON.stringify(dir)}, env: { ...process.env, ...env }, detached: true, stdio: "ignore" }).unref();
setInterval(() => {}, 60_000);
`,
  );
  writeFileSync(join(dir, "model.gguf"), "GGUF, as far as the stand-in looks");
  const ollama = installScript("fake-ollama", join(dir, "ollama"));
  writeFileSync(`${ollama}.json`, JSON.stringify({ log: join(dir, "ollama.log"), runner: true }));
  const servers = [
    { argv: [join(FIXTURES, "fake-comfy"), "--port", String(freePort())], env: {}, log: "fake-comfy.log" },
    { argv: [join(FIXTURES, "fake-llama-server"), "-m", join(dir, "model.gguf"), "--port", String(freePort())], env: { FAKE_LLAMA_LOG: join(dir, "llama.log") }, log: "llama.log" },
    { argv: [join(FIXTURES, "fake-ggml-rpc-server"), "-p", String(freePort())], env: { FAKE_RPC_LOG: join(dir, "rpc.log") }, log: "rpc.log" },
    { argv: [ollama, "serve"], env: { OLLAMA_HOST: `127.0.0.1:${freePort()}` }, log: "ollama.log" },
  ];
  const runs = servers.map((s) => Bun.spawn([process.execPath, join(dir, "run.ts"), JSON.stringify(s)], { stdout: "ignore", stderr: "ignore" }));
  // Each notes its start once it runs (fake-comfy as { started }, the others as { pid }; Ollama's runner as { runner }).
  const noteOf = (log: string) => (existsSync(join(dir, log)) ? (JSON.parse(readFileSync(join(dir, log), "utf8").split("\n")[0]) as { started?: number; pid?: number; runner?: number }) : null);
  expect(await until(() => servers.every((s) => noteOf(s.log)), 10_000)).toBe(true);
  const pids = servers.map((s) => noteOf(s.log)!).flatMap((n) => [n.started ?? n.pid!, ...(n.runner ? [n.runner] : [])]);
  elsewhere.push(...pids);
  expect(pids).toHaveLength(5);
  // While whoever started them runs, they run.
  await Bun.sleep(700);
  expect(pids.filter((p) => !alive(p))).toEqual([]);
  // It's killed, as a test run is when it's stopped (nothing of its afterEach runs): they go too, Ollama's runner with it.
  for (const r of runs) r.kill("SIGKILL");
  expect(await until(() => pids.every((p) => !alive(p)), 5000)).toBe(true);
}, 30_000);
