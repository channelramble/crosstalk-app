// deploy/install-macos.sh, the Mac installer, runs here for real with stand-ins first on its PATH: launchctl, sudo,
// pmset, security, codesign, tailscale, open and curl only write down what they were asked. The program it installs is
// a script and HOME a temporary folder, so nothing reaches the real launchd, power settings, Tailscale or ~/.crosstalk.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../deploy/install-macos.sh");
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

function install(opts: { args?: string[]; before?: string; tailscale?: "up" | "signed-out" | "none" | "no-https"; awake?: boolean; autoLogin?: boolean } = {}) {
  const home = temp("ct-mac-home-");
  const bin = temp("ct-mac-bin-");
  const calls = join(bin, "calls.log");
  const tool = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const note = (name: string) => `echo "${name} $*" >> "${calls}"`;
  const ts = opts.tailscale ?? "up";
  tool("uname", `case "$1" in -s) echo Darwin ;; -m) echo arm64 ;; *) /usr/bin/uname "$@" ;; esac`);
  tool("launchctl", note("launchctl"));
  tool("sudo", `${note("sudo")}\nexit 0`);
  tool("pmset", opts.awake ? `echo " sleep                0"; echo " autorestart          1"` : `echo " sleep                1"; echo " autorestart          0"`);
  tool("defaults", opts.autoLogin ? `id -un` : "exit 1");
  tool("security", "exit 0");
  tool("codesign", note("codesign"));
  tool("xattr", "exit 0");
  tool("xcodebuild", `case "$1" in -version) echo "Xcode 27.0" ;; esac; exit 0`);
  tool("curl", "exit 0");
  tool("open", note("open"));
  tool("sleep", "exit 0");
  // plutil: the plist is fine; and of Tailscale's status, this Mac's name and whether HTTPS certificates are on.
  tool("plutil", `case "$*" in *Self.DNSName*) cat >/dev/null; echo "mini.example.ts.net." ;; *CertDomains*) cat >/dev/null; ${ts === "no-https" ? "exit 1" : 'echo "mini.example.ts.net"'} ;; *) exit 0 ;; esac`);
  if (ts !== "none") tool("tailscale", `${note("tailscale")}\n${ts === "signed-out" ? "exit 1" : 'if [ "$2" = --json ]; then echo "{}"; fi'}`);
  const hub = join(bin, "crosstalk-hub-darwin-arm64");
  tool("crosstalk-hub-darwin-arm64", `case "$1" in version) echo 0.9.0 ;; pair) echo "pair $*" >> "${calls}"; echo "Pairing code: AB23-9XYZ  (valid until 16:32)"; case "$*" in *--url*) echo; echo "[the QR code]"; echo "Or open $4 on the phone and type the code." ;; esac ;; esac`);
  if (opts.before) {
    mkdirSync(join(home, ".crosstalk"), { recursive: true });
    writeFileSync(join(home, ".crosstalk/crosstalk.db"), "");
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    writeFileSync(join(home, ".local/bin/crosstalk-hub"), `#!/bin/sh\necho ${opts.before}\n`);
    chmodSync(join(home, ".local/bin/crosstalk-hub"), 0o755);
  }
  const PATH = `${bin}:/usr/bin:/bin`;
  // The stand-ins must win, or the installer would change this Mac.
  for (const name of ["uname", "launchctl", "sudo", "pmset", "defaults", "security", "codesign", "curl", "open", "plutil", "xcodebuild"]) expect(Bun.which(name, { PATH })).toBe(join(bin, name));
  const done = Bun.spawnSync([BASH!, SCRIPT, hub, ...(opts.args ?? [])], {
    // CROSSTALK_TAILSCALE_APP: with no `tailscale` on the PATH the installer looks inside Tailscale's app, which a
    // Mac running these tests may well have. It must never be reached: `tailscale serve` there would repoint that
    // Mac's real address at the test's port. Keep this.
    env: { PATH, HOME: home, USER: "someone", LANG: "en_US.UTF-8", CROSSTALK_PORT: "7431", CROSSTALK_LABEL: "com.crosstalk.hub.test", SIGN_IDENTITY: "-", CROSSTALK_TAILSCALE_APP: join(bin, "no-tailscale-here") },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  const plist = join(home, "Library/LaunchAgents/com.crosstalk.hub.test.plist");
  return {
    exit: done.exitCode,
    out: (done.stdout.toString() + done.stderr.toString()).replace(/\x1b\[[0-9;]*m/g, ""),
    calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [],
    plist: existsSync(plist) ? readFileSync(plist, "utf8") : "",
    installed: existsSync(join(home, ".local/bin/crosstalk-hub")),
  };
}

describe.skipIf(!BASH || process.platform !== "darwin")("deploy/install-macos.sh", () => {
  test("a first install: four plain lines, then the code and its QR code for a phone, and nothing about tools most people don't need", () => {
    const r = install();
    expect(r.exit).toBe(0);
    expect(r.installed).toBe(true);
    expect(r.plist).toContain("<key>CROSSTALK_PORT</key><string>7431</string>");
    expect(r.plist).toContain("<key>CROSSTALK_PUBLIC_URL</key><string>https://mini.example.ts.net</string>");
    expect(r.calls.some((c) => c.startsWith("launchctl bootstrap "))).toBe(true);
    expect(r.calls).toContain("sudo pmset -a sleep 0 disksleep 0 womp 1 autorestart 1 powernap 0");
    expect(r.calls).toContain("tailscale serve --bg --https=443 http://127.0.0.1:7431");
    expect(r.out).toContain("✓ Installed version 0.9.0");
    expect(r.out).toContain("✓ Running. It starts by itself when you log in.");
    expect(r.out).toContain("✓ This Mac stays awake");
    expect(r.out).toContain("✓ Your devices reach it at https://mini.example.ts.net");
    expect(r.out).toContain("Pair your phone");
    expect(r.calls).toContain("pair pair 60 --url https://mini.example.ts.net");
    expect(r.out).toContain("[the QR code]");
    expect(r.out).not.toMatch(/npm|Homebrew|Simulator|Signed|ad hoc|[0-9]\/5/);
    // Not at a terminal here (nobody is watching): no browser is opened.
    expect(r.calls.filter((c) => c.startsWith("open "))).toEqual([]);
  });

  test("an update: what it went from and to, no password for a Mac that already stays awake, and no pairing code unless asked", () => {
    const r = install({ before: "0.8.1", awake: true, autoLogin: true });
    expect(r.exit).toBe(0);
    expect(r.out).toContain("✓ Updated from 0.8.1 to 0.9.0");
    expect(r.calls.filter((c) => c.startsWith("sudo"))).toEqual([]);
    expect(r.calls.filter((c) => c.startsWith("pair "))).toEqual([]);
    expect(r.out).toContain("To pair another device: Settings → This device → Pair a new device, or run: crosstalk-hub pair");
    expect(r.out).not.toContain("Automatically log in");
    expect(install({ before: "0.8.1", awake: true, args: ["--pair"] }).calls).toContain("pair pair 60 --url https://mini.example.ts.net");
  });

  test("Tailscale missing, signed out, or without HTTPS: it still installs, says the one thing to do, and gives this Mac's own address and code", () => {
    const none = install({ tailscale: "none" });
    expect(none.exit).toBe(0);
    expect(none.out).toContain("Your phone can't reach this Mac yet. Install Tailscale here and on the phone (https://tailscale.com/download), sign in to both, then run this again.");
    expect(none.out).toContain("On this Mac, Crosstalk is at http://127.0.0.1:7431");
    expect(none.calls).toContain("pair pair 60");
    expect(none.plist).not.toContain("CROSSTALK_PUBLIC_URL");
    expect(install({ tailscale: "signed-out" }).out).toContain("Tailscale is installed but not signed in.");
    const noHttps = install({ tailscale: "no-https" });
    expect(noHttps.exit).toBe(0);
    expect(noHttps.out).toContain("open https://login.tailscale.com/admin/dns, turn on HTTPS Certificates, then run this again");
    expect(noHttps.calls.filter((c) => c.startsWith("tailscale serve"))).toEqual([]);
  });

  test("--no-power and --no-tailscale leave the Mac's settings alone (what Crosstalk Hub's own install passes)", () => {
    const r = install({ args: ["--no-power", "--no-tailscale"] });
    expect(r.exit).toBe(0);
    expect(r.calls.filter((c) => /^(sudo|tailscale) /.test(c))).toEqual([]);
    expect(r.plist).not.toContain("CROSSTALK_PUBLIC_URL");
  });
});
