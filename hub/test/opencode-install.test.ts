// How Crosstalk gets its pinned OpenCode and finds it again. A version 1 owns the same `opencode` command: in the folder
// Crosstalk installs to, npm refused to overwrite it, and earlier on the hub's PATH it was found again after a good install,
// so Install and Try again went round for ever. Everything runs in a temp home with stand-ins for npm and the program.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OPENCODE_VERSION } from "@crosstalk/shared";
import { App } from "../src/app";
import { OPENCODE_INSTALL_LINE, opencodeProvider } from "../src/providers/opencode";
import "../src/providers/all";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function home() {
  const dir = mkdtempSync(join(tmpdir(), "ct-oc-install-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function program(path: string, version: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\necho "opencode v${version}"\n`);
  chmodSync(path, 0o755);
  return path;
}

/** What a hub whose home is `dir` says of OpenCode, with `~/.local/bin` first on PATH as on the hub's service. */
async function statusIn(dir: string) {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "fixtures", "opencode-status.ts")], { env: { ...process.env, HOME: dir, PATH: `${join(dir, ".local/bin")}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return JSON.parse(out.split("\n").find((line) => line.startsWith("{"))!);
}

describe("which OpenCode the hub runs", () => {
  test("a version 1 earlier on PATH is said to be wrong only while it's all there is: Crosstalk's own copy comes first", async () => {
    const dir = home();
    const v1 = program(join(dir, ".local/bin/opencode"), "1.19.5");
    expect(await statusIn(dir)).toMatchObject({ installed: true, version: "1.19.5", binPath: v1, error: "OpenCode 1.19.5 is installed, and Crosstalk needs version 2. Press Install to get it." });

    const own = program(join(dir, ".npm-global/bin/opencode"), OPENCODE_VERSION);
    expect(await statusIn(dir)).toMatchObject({ installed: true, version: OPENCODE_VERSION, binPath: own, error: null, signedIn: true });
    // The person's own copy stays, for their terminal.
    expect(existsSync(v1)).toBe(true);
  });

  test("another version 2 earlier on PATH doesn't stand in for it either, so Update isn't left saying the same thing", async () => {
    const dir = home();
    program(join(dir, ".local/bin/opencode"), "2.2.4");
    const own = program(join(dir, ".npm-global/bin/opencode"), OPENCODE_VERSION);
    expect(await statusIn(dir)).toMatchObject({ version: OPENCODE_VERSION, binPath: own });
  });

  test("the check with no agent programs still finds nothing", () => {
    const app = new App({ dbPath: ":memory:", config: { port: 0, host: "127.0.0.1", publicUrl: null, workspaceRoot: tmpdir(), maxHopsDefault: 6 } });
    cleanups.push(() => app.shutdown());
    process.env.CROSSTALK_NO_AGENT_CLIS = "1";
    cleanups.push(() => void delete process.env.CROSSTALK_NO_AGENT_CLIS);
    expect(app.providers.which("opencode")).toBeNull();
  });
});

describe("the install line", () => {
  /**
   * Stands in for npm as far as this line needs: `uninstall` takes the package's command away, `install` refuses to overwrite
   * a command that's there (EEXIST), and, like npm 12, leaves a stub without --allow-scripts naming the package.
   */
  function fakeNpm(dir: string, uninstallExit = 0) {
    const bin = join(dir, "fake-npm");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "npm"),
      `#!/bin/sh
echo "$*" >> "$HOME/npm.log"
target="$HOME/.npm-global/bin/opencode"
if [ "$1" = uninstall ]; then
  rm -f "$target"
  exit ${uninstallExit}
fi
if [ -e "$target" ]; then echo "npm error code EEXIST" >&2; exit 1; fi
mkdir -p "$(dirname "$target")"
case "$*" in
  *--allow-scripts=@opencode/cli*) printf '#!/bin/sh\\necho "opencode v${OPENCODE_VERSION}"\\n' > "$target" ;;
  *) printf 'stub' > "$target" ;;
esac
chmod +x "$target"
`,
    );
    chmodSync(join(bin, "npm"), 0o755);
    return bin;
  }

  /** The line as the installer runs it: under `set -e`. Not through a login shell, which could put a real npm first. */
  const runLine = (dir: string, bin: string) => Bun.spawn(["bash", "-c", `set -e; ${OPENCODE_INSTALL_LINE}`], { env: { HOME: dir, PATH: `${bin}:/usr/bin:/bin` }, stdout: "ignore", stderr: "ignore" }).exited;

  test("the installer runs it, under set -e, and the version it pins", () => {
    const command = opencodeProvider.installCommand!.join(" ");
    expect(command).toContain(`set -e;`);
    expect(command).toContain(OPENCODE_INSTALL_LINE);
    expect(OPENCODE_INSTALL_LINE).toContain(`@opencode/cli@${OPENCODE_VERSION}`);
  });

  test("a version 1 in the folder it installs to is replaced, and the program is really there after", async () => {
    const dir = home();
    const v1 = program(join(dir, ".npm-global/bin/opencode"), "1.19.5");
    expect(await runLine(dir, fakeNpm(dir))).toBe(0);
    expect(readFileSync(v1, "utf8")).toContain(`opencode v${OPENCODE_VERSION}`);
    const log = readFileSync(join(dir, "npm.log"), "utf8").trim().split("\n");
    expect(log).toHaveLength(2);
    expect(log[0]).toStartWith("uninstall -g");
    expect(log[0]).toEndWith("opencode-ai");
  });

  test("a machine with nothing there just installs; an uninstall that fails stops it there", async () => {
    const dir = home();
    expect(await runLine(dir, fakeNpm(dir))).toBe(0);
    expect(readFileSync(join(dir, ".npm-global/bin/opencode"), "utf8")).toContain(`opencode v${OPENCODE_VERSION}`);

    const other = home();
    expect(await runLine(other, fakeNpm(other, 1))).toBe(1);
    expect(readFileSync(join(other, "npm.log"), "utf8").trim().split("\n")).toHaveLength(1);
  });
});
