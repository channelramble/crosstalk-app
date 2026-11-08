// deploy/install.sh, the Linux installer, runs here for real with stand-ins first on its PATH: uname says Linux, and
// systemctl, loginctl, tailscale and sudo only write down what they were asked (python3 reads Tailscale's name). The hub
// binary is a script and HOME a temporary folder, so nothing reaches the real systemd, Tailscale, sudo or ~/.crosstalk.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../deploy/install.sh");
const BASH = Bun.which("bash");

const dirs: string[] = [];
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function install(env: Record<string, string> = {}) {
  const home = temp("ct-install-home-");
  const bin = temp("ct-install-bin-");
  const calls = join(bin, "calls.log");
  const tool = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const note = (name: string) => `echo "${name} $*" >> "${calls}"`;
  tool("uname", `case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) /usr/bin/uname "$@" ;; esac`);
  tool("systemctl", note("systemctl"));
  tool("loginctl", `${note("loginctl")}\nif [ "$1" = show-user ]; then echo no; fi`);
  tool("tailscale", `${note("tailscale")}\nif [ "$2" = --json ]; then echo '{"Self":{"DNSName":"box.example.ts.net."}}'; fi`);
  tool("python3", "cat >/dev/null\necho box.example.ts.net");
  tool("sudo", `${note("sudo")}\nexit 1`);
  tool("sleep", "exit 0");
  tool("crosstalk-hub-linux-x64", `case "$1" in version) echo 0.4.1 ;; pair) echo "Pairing code: AB23-9XYZ  (valid until 16:32)" ;; esac`);
  const PATH = `${bin}:/usr/bin:/bin`;
  // The stand-ins must win, or the installer would change this computer.
  for (const name of ["uname", "systemctl", "loginctl", "tailscale", "sudo"]) expect(Bun.which(name, { PATH })).toBe(join(bin, name));
  const done = Bun.spawnSync([BASH!, SCRIPT, join(bin, "crosstalk-hub-linux-x64")], {
    env: { PATH, HOME: home, USER: "someone", LANG: "en_US.UTF-8", CROSSTALK_PORT: "7431", ...env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  const unit = join(home, ".config/systemd/user/crosstalk-hub.service");
  return {
    exit: done.exitCode,
    out: done.stdout.toString() + done.stderr.toString(),
    calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [],
    unit: existsSync(unit) ? readFileSync(unit, "utf8") : "",
  };
}

describe.skipIf(!BASH)("deploy/install.sh", () => {
  test("keeps the hub running after logout and publishes it with Tailscale, as it always did", () => {
    const r = install();
    expect(r.exit).toBe(0);
    expect(r.calls).toContain("loginctl enable-linger someone");
    expect(r.calls).toContain("tailscale serve --bg --https=443 http://127.0.0.1:7431");
    expect(r.calls).toContain("systemctl --user restart crosstalk-hub");
    expect(r.unit).toContain("Environment=CROSSTALK_PORT=7431");
    expect(r.unit).toContain("Environment=CROSSTALK_PUBLIC_URL=https://box.example.ts.net");
    expect(r.calls.filter((c) => c.startsWith("sudo"))).toEqual([]);
  });

  test("CROSSTALK_NO_LINGER and CROSSTALK_NO_TAILSCALE leave linger and Tailscale alone (a trial's install)", () => {
    const r = install({ CROSSTALK_NO_LINGER: "1", CROSSTALK_NO_TAILSCALE: "1" });
    expect(r.exit).toBe(0);
    expect(r.calls.filter((c) => /^(loginctl|tailscale|sudo) /.test(c))).toEqual([]);
    expect(r.out).toContain("Not keeping it running when you're logged out (CROSSTALK_NO_LINGER)");
    expect(r.out).toContain("skipped (CROSSTALK_NO_TAILSCALE)");
    expect(r.out).toContain("Open   http://127.0.0.1:7431");
    expect(r.unit).not.toContain("CROSSTALK_PUBLIC_URL");
    expect(r.calls).toContain("systemctl --user restart crosstalk-hub");
  });
});
