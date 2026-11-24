// deploy/install.sh, the Linux installer, runs here for real with stand-ins first on its PATH: uname says Linux, and
// systemctl, loginctl, tailscale and sudo only write down what they were asked (python3 reads Tailscale's name). The hub
// binary is a script and HOME a temporary folder, so nothing reaches the real systemd, Tailscale, sudo or ~/.crosstalk.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  // SYSTEMD_AFTER: the person's own systemd answers only from that ask on (it's still starting); SYSTEMD_DOWN: never.
  const answersFrom = env.SYSTEMD_DOWN ? 1_000_000 : Number(env.SYSTEMD_AFTER ?? 1);
  tool("systemctl", `${note("systemctl")}\nif [ "$2" = show-environment ]; then [ "$(grep -c "show-environment" "${calls}")" -ge ${answersFrom} ] || exit 1; fi`);
  // This Linux's first program is systemd (read from /proc, which a Mac running these tests doesn't have).
  tool("cat", `if [ "$1" = /proc/1/comm ]; then echo systemd; else /bin/cat "$@"; fi`);
  tool("loginctl", `${note("loginctl")}\nif [ "$1" = show-user ]; then echo no; fi${env.LINGER_REFUSED ? '\nif [ "$1" = enable-linger ]; then exit 1; fi' : ""}`);
  // As Tailscale prints it: on several lines, this machine first, then the others.
  tool("tailscale", `${note("tailscale")}\nif [ "$2" = --json ]; then printf '{\\n  "Version": "1.80",\\n  "Self": {\\n    "ID": "n1",\\n    "HostName": "box",\\n    "DNSName": "box.example.ts.net.",\\n    "TailscaleIPs": ["100.64.0.1"]\\n  },\\n  "Peer": {"k": {"DNSName": "phone.example.ts.net."}}\\n}\\n'; fi${env.TAILSCALE_DOWN ? "\nexit 1" : ""}`);
  // No python on this machine: the installer mustn't need one.
  tool("python3", "exit 127");
  tool("curl", "exit 0");
  if (env.NO_TAILSCALE_PROGRAM) rmSync(join(bin, "tailscale"));
  tool("sudo", `${note("sudo")}\nexit 1`);
  tool("sleep", "exit 0");
  tool("crosstalk-hub-linux-x64", `case "$1" in version) echo 0.9.0 ;; pair) echo "pair $*" >> "${calls}"; echo "Pairing code: AB23-9XYZ  (valid until 16:32)"; case "$*" in *--url*) echo; echo "[the QR code]"; echo "Or open $4 on the phone and type the code." ;; esac ;; esac`);
  if (env.INSTALLED_BEFORE) {
    mkdirSync(join(home, ".crosstalk"), { recursive: true });
    writeFileSync(join(home, ".crosstalk/crosstalk.db"), "");
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    writeFileSync(join(home, ".local/bin/crosstalk-hub"), "#!/bin/sh\necho 0.8.1\n");
    chmodSync(join(home, ".local/bin/crosstalk-hub"), 0o755);
  }
  const PATH = `${bin}:/usr/bin:/bin`;
  // The stand-ins must win, or the installer would change this computer.
  for (const name of ["uname", "systemctl", "loginctl", "sudo", "curl", ...(env.NO_TAILSCALE_PROGRAM ? [] : ["tailscale"])]) expect(Bun.which(name, { PATH })).toBe(join(bin, name));
  const done = Bun.spawnSync([BASH!, SCRIPT, join(bin, "crosstalk-hub-linux-x64"), ...(env.ARGS ? env.ARGS.split(" ") : [])], {
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
  test("a first install: running, kept running after logout, published with Tailscale, and it ends with the code and its QR code for a phone", () => {
    const r = install();
    expect(r.exit).toBe(0);
    expect(r.calls).toContain("loginctl enable-linger someone");
    expect(r.calls).toContain("tailscale serve --bg --https=443 http://127.0.0.1:7431");
    expect(r.calls).toContain("systemctl --user restart crosstalk-hub");
    expect(r.unit).toContain("Environment=CROSSTALK_PORT=7431");
    // The machine's own name, read without python, and not another device's.
    expect(r.unit).toContain("Environment=CROSSTALK_PUBLIC_URL=https://box.example.ts.net");
    expect(r.calls.filter((c) => c.startsWith("sudo"))).toEqual([]);
    expect(r.out).toContain("Installed version 0.9.0");
    expect(r.out).toContain("Running. It starts by itself with this machine.");
    expect(r.out).toContain("Your devices reach it at https://box.example.ts.net");
    expect(r.calls).toContain("pair pair 60 --url https://box.example.ts.net");
    expect(r.out).toContain("Pair your phone");
    expect(r.out).toContain("Pairing code: AB23-9XYZ");
    expect(r.out).toContain("[the QR code]");
    // Nothing about tools most people don't need.
    expect(r.out).not.toMatch(/npm|Xcode|1\/5/);
  });

  test("an update says what it went from and to, and makes no pairing code unless asked", () => {
    const r = install({ INSTALLED_BEFORE: "1" });
    expect(r.exit).toBe(0);
    expect(r.out).toContain("Updated from 0.8.1 to 0.9.0");
    expect(r.calls.filter((c) => c.startsWith("pair "))).toEqual([]);
    expect(r.out).toContain("To pair another device: Settings → This device → Pair a new device, or run: crosstalk-hub pair");
    const asked = install({ INSTALLED_BEFORE: "1", ARGS: "--pair" });
    expect(asked.calls).toContain("pair pair 60 --url https://box.example.ts.net");
  });

  test("without Tailscale it still installs, says how the phone will reach it, and gives a code for this machine's own browser", () => {
    const none = install({ NO_TAILSCALE_PROGRAM: "1" });
    expect(none.exit).toBe(0);
    expect(none.out).toContain("Your phone can't reach this machine yet. Install Tailscale here and on the phone (https://tailscale.com/download)");
    expect(none.out).toContain("On this machine, Crosstalk is at http://127.0.0.1:7431");
    expect(none.calls).toContain("pair pair 60");
    expect(none.unit).not.toContain("CROSSTALK_PUBLIC_URL");
    const down = install({ TAILSCALE_DOWN: "1" });
    expect(down.exit).toBe(0);
    expect(down.out).toContain("Tailscale is installed but not connected. Run: sudo tailscale up");
  });

  test("CROSSTALK_NO_LINGER and CROSSTALK_NO_TAILSCALE leave linger and Tailscale alone (a trial's install)", () => {
    const r = install({ CROSSTALK_NO_LINGER: "1", CROSSTALK_NO_TAILSCALE: "1" });
    expect(r.exit).toBe(0);
    expect(r.calls.filter((c) => /^(loginctl enable|tailscale|sudo) /.test(c))).toEqual([]);
    expect(r.out).toContain("Not keeping it running when you're logged out (CROSSTALK_NO_LINGER)");
    expect(r.out).toContain("Not publishing it with Tailscale (CROSSTALK_NO_TAILSCALE)");
    expect(r.out).toContain("On this machine, Crosstalk is at http://127.0.0.1:7431");
    expect(r.unit).not.toContain("CROSSTALK_PUBLIC_URL");
    expect(r.calls).toContain("systemctl --user restart crosstalk-hub");
  });

  test("its own systemd still starting (Ubuntu inside Windows just after systemd was turned on) is waited for, not taken for missing", () => {
    const r = install({ SYSTEMD_AFTER: "3" });
    expect(r.exit).toBe(0);
    expect(r.calls.filter((c) => c === "systemctl --user show-environment")).toHaveLength(3);
    expect(r.calls).toContain("systemctl --user restart crosstalk-hub");
    expect(r.out).toContain("Installed version 0.9.0");
  });

  test("with no systemd of the person's own answering it says so and what to do, and installs nothing", () => {
    const r = install({ SYSTEMD_DOWN: "1" });
    expect(r.exit).not.toBe(0);
    expect(r.out).toContain("systemd isn't answering here (systemctl --user). Log in as yourself (not with su), then run this again.");
    expect(r.out).not.toContain("Installed version");
    expect(r.unit).toBe("");
    expect(r.calls.every((c) => c === "systemctl --user show-environment")).toBe(true);
  });

  test("the words Crosstalk Hub looks for when a step needed a password it couldn't ask for are still said", () => {
    // sudo fails here (no terminal), as it does under the app.
    const r = install({ LINGER_REFUSED: "1" });
    expect(r.out).toContain("couldn't enable linger");
  });
});
