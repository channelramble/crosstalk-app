import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError } from "./engine/engine";
import { secretToken } from "./util/ids";
import type { Store } from "./db";

/**
 * Other computers the agents can run commands on (for example a MacBook with an iPhone plugged in).
 * The hub keeps one SSH key; connecting a computer means running a one-line command on it that authorizes
 * that key and reports back its user and address. Agents then use `ssh -F <config> <name> '<command>'`.
 */

export interface Computer {
  name: string; // ssh alias, e.g. "macbook"
  label: string; // the computer's own name, e.g. "Jane-MacBook-Pro"
  host: string; // Tailscale IP or hostname
  user: string;
  addedAt: number;
  /** "windows" when it runs Windows (commands go to cmd.exe, not a Unix shell); missing for Mac and Linux. */
  os?: "windows" | "linux";
}

export interface ComputerStatus extends Computer {
  online: boolean;
  detail: string;
}

const INVITE_TTL = 15 * 60_000;
const SAFE_USER = /^[a-z_][a-z0-9_.-]{0,31}$/i;
const SAFE_HOST = /^[A-Za-z0-9.-]{1,253}$/;

export class Computers {
  private invites = new Map<string, number>(); // token -> expiry
  private claimed = new Map<string, { name: string; expires: number }>(); // token -> computer it connected

  constructor(
    private store: Store,
    readonly dir: string,
  ) {
    // Rewrite the ssh config, so options added by newer hubs (like keep-alives) reach computers connected before.
    if (this.list().length) this.writeConfig();
  }

  /** The folder is made when something is first written to it (a hub that never connects a computer leaves none). */
  private ready() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  get keyPath(): string {
    return join(this.dir, "id_ed25519");
  }

  get configPath(): string {
    return join(this.dir, "config");
  }

  /** The hub's public key, created on first use. */
  publicKey(): string {
    if (!existsSync(this.keyPath)) {
      this.ready();
      const r = Bun.spawnSync(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "crosstalk-agents", "-f", this.keyPath, "-q"]);
      if (r.exitCode !== 0) throw new HttpError(500, `Couldn't create the hub's SSH key: ${r.stderr.toString().trim()}`);
    }
    return readFileSync(`${this.keyPath}.pub`, "utf8").trim();
  }

  list(): Computer[] {
    try {
      return JSON.parse(this.store.kvGet("computers") ?? "[]") as Computer[];
    } catch {
      return [];
    }
  }

  private save(list: Computer[]) {
    this.store.kvSet("computers", JSON.stringify(list));
    this.writeConfig(list);
  }

  /** One ssh config for all computers, so agents never need to know keys, users or addresses. */
  private writeConfig(list = this.list()) {
    const known = join(this.dir, "known_hosts");
    const blocks = list.map((c) =>
      [
        `Host ${c.name}`,
        `  HostName ${c.host}`,
        `  User ${c.user}`,
        `  IdentityFile "${this.keyPath}"`,
        `  IdentitiesOnly yes`,
        `  UserKnownHostsFile "${known}"`,
        `  StrictHostKeyChecking accept-new`,
        `  ConnectTimeout 8`,
        // A connection that drops mid-command (the computer sleeps, changes network) fails in ~45 s instead of hanging.
        `  ServerAliveInterval 15`,
        `  ServerAliveCountMax 3`,
        `  BatchMode yes`,
      ].join("\n"),
    );
    this.ready();
    writeFileSync(this.configPath, `# Written by Crosstalk. Use: ssh -F "${this.configPath}" <name> '<command>'\n\n${blocks.join("\n\n")}\n`, { mode: 0o600 });
  }

  /** A one-time code (15 minutes) for the connect command. */
  invite(): { token: string; expiresAt: number } {
    this.publicKey();
    const token = secretToken().replace(/[^A-Za-z0-9]/g, "").slice(0, 24);
    const now = Date.now();
    for (const [t, exp] of this.invites) if (exp < now) this.invites.delete(t);
    for (const [t, c] of this.claimed) if (c.expires < now) this.claimed.delete(t);
    this.invites.set(token, now + INVITE_TTL);
    return { token, expiresAt: now + INVITE_TTL };
  }

  private checkInvite(token: string) {
    const exp = this.invites.get(token);
    if (!exp || exp < Date.now()) throw new HttpError(401, "This connect command has expired. Make a new one in Crosstalk → Computers.");
  }

  /** The shell script the connect command downloads. Only valid with a live invite. */
  script(token: string, hubUrl: string): string {
    this.checkInvite(token);
    const key = this.publicKey();
    const claim = `${hubUrl.replace(/\/+$/, "")}/api/computers/claim/${token}`;
    return `#!/bin/sh
# Lets Crosstalk's agents run commands on this computer. Undo: turn off Remote Login (a Mac) or the SSH server
# (Linux), or delete the "crosstalk-agents" line from ~/.ssh/authorized_keys.
set -e
OS=$(uname -s)
# Is an SSH server listening? (Linux may lack nc: ask ss or systemd instead.)
if [ "$OS" = Linux ]; then
  if ! { ss -ltn 2>/dev/null | grep -qE '[:.]22[[:space:]]'; } && ! systemctl is-active --quiet ssh 2>/dev/null && ! systemctl is-active --quiet sshd 2>/dev/null; then
    echo "The SSH server isn't running. Install and start it (Ubuntu/Debian):"
    echo "  sudo apt install -y openssh-server && sudo systemctl enable --now ssh"
    echo "then run this again."
    exit 1
  fi
elif ! nc -z -G 2 127.0.0.1 22 2>/dev/null && ! nc -z -w 2 127.0.0.1 22 2>/dev/null; then
  echo "Remote Login is off. Turn it on in System Settings > General > Sharing > Remote Login, then run this again."
  open "x-apple.systempreferences:com.apple.Sharing-Settings.extension" 2>/dev/null || true
  exit 1
fi
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
AK="$HOME/.ssh/authorized_keys"
touch "$AK" && chmod 600 "$AK"
# If the file doesn't end with a newline, add one so the key goes on its own line.
if ! grep -qF '${key}' "$AK"; then
  [ -n "$(tail -c 1 "$AK")" ] && echo >> "$AK"
  echo '${key}' >> "$AK"
fi
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
command -v tailscale >/dev/null 2>&1 && TS=tailscale
IP=$("$TS" ip -4 2>/dev/null | head -n 1 || true)
NAME=$( (scutil --get ComputerName 2>/dev/null || hostname) | tr -d '"\\')
KIND=mac
if [ "$OS" = Linux ]; then KIND=linux; fi
RES=$(curl -fsS -X POST '${claim}' -H 'content-type: application/json' \\
  -d "{\\"user\\":\\"$(whoami)\\",\\"host\\":\\"$IP\\",\\"label\\":\\"$NAME\\",\\"os\\":\\"$KIND\\"}")
# The hub tries to sign in right away; only report success if that worked.
if printf '%s' "$RES" | grep -q '"online":true'; then
  echo "Connected to Crosstalk. You can close this window."
else
  echo "Crosstalk saved this computer but couldn't sign in to it yet."
  if [ "$OS" = Linux ]; then echo "Check that the SSH server allows your user ($(whoami)) to sign in with a key, then press Test in Crosstalk."
  else echo "Check System Settings > General > Sharing > Remote Login: allow access for your user ($(whoami)), then press Test in Crosstalk."; fi
  exit 1
fi
`;
  }

  /** The same as `script`, for Windows: PowerShell, run as administrator (turning on Windows' SSH server needs it). */
  windowsScript(token: string, hubUrl: string): string {
    this.checkInvite(token);
    const key = this.publicKey();
    const claim = `${hubUrl.replace(/\/+$/, "")}/api/computers/claim/${token}`;
    return `# Lets Crosstalk's agents run commands on this computer over SSH (Windows' OpenSSH Server).
# Undo: Settings > System > Optional features > OpenSSH Server > Remove, or delete the "crosstalk-agents" line from
# C:\\ProgramData\\ssh\\administrators_authorized_keys.
$ErrorActionPreference = 'Stop'
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Run this in PowerShell as administrator: right-click PowerShell (or Terminal) > Run as administrator." -ForegroundColor Yellow
  return
}
$cap = Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*' | Select-Object -First 1
if ($cap -and $cap.State -ne 'Installed') {
  Write-Host 'Turning on OpenSSH Server (a built-in Windows feature). This can take a minute...'
  Add-WindowsCapability -Online -Name $cap.Name | Out-Null
}
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
}
# Windows reads administrators' SSH keys from this file, and only if just Administrators and SYSTEM can change it.
$keyFile = Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys'
$key = '${key}'
if (-not (Test-Path $keyFile)) { New-Item -ItemType File -Path $keyFile -Force | Out-Null }
if (-not (Select-String -Path $keyFile -SimpleMatch $key -Quiet)) { Add-Content -Path $keyFile -Value $key -Encoding ascii }
icacls $keyFile /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
$ts = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $ts) { $ts = Join-Path $env:ProgramFiles 'Tailscale\\tailscale.exe' }
if (-not (Test-Path $ts)) { Write-Host "Tailscale isn't installed here. Install it and sign in to the same tailnet as the hub, then run this again." -ForegroundColor Yellow; return }
$ip = (& $ts ip -4 | Select-Object -First 1).Trim()
$body = @{ user = $env:USERNAME; host = $ip; label = $env:COMPUTERNAME; os = 'windows' } | ConvertTo-Json
$res = Invoke-RestMethod -Method Post -Uri '${claim}' -ContentType 'application/json' -Body $body
if ($res.online) {
  Write-Host "Connected to Crosstalk. You can close this window." -ForegroundColor Green
} else {
  Write-Host "Crosstalk saved this computer but couldn't sign in to it yet: $($res.detail)" -ForegroundColor Yellow
}
`;
  }

  /** The connect script reports back: save the computer under a short name and check it works. */
  async claim(token: string, body: { user?: unknown; host?: unknown; label?: unknown; os?: unknown }): Promise<ComputerStatus> {
    this.checkInvite(token);
    const user = String(body.user ?? "");
    const host = String(body.host ?? "");
    const label = String(body.label ?? "").slice(0, 80) || host;
    if (!SAFE_USER.test(user) || !SAFE_HOST.test(host)) throw new HttpError(400, "Couldn't read this computer's user or Tailscale address. Is Tailscale running on it?");
    this.invites.delete(token);
    // Reconnecting the same computer keeps its name, so agents' instructions stay valid.
    const previous = this.list().find((c) => c.host === host);
    const list = this.list().filter((c) => c.host !== host);
    const base = label.toLowerCase().includes("macbook") ? "macbook" : label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "computer";
    let name = previous?.name ?? base;
    for (let i = 2; list.some((c) => c.name === name); i++) name = `${base}-${i}`;
    const os = body.os === "windows" || body.os === "linux" ? body.os : null;
    const computer: Computer = { name, label, host, user, addedAt: Date.now(), ...(os ? { os } : {}) };
    this.save([...list, computer]);
    this.claimed.set(token, { name, expires: Date.now() + INVITE_TTL });
    return this.test(name);
  }

  /** Whether the connect command for this invite has run yet, and which computer it connected. */
  inviteStatus(token: string): { connected: ComputerStatus | null; waiting: boolean } | Promise<{ connected: ComputerStatus | null; waiting: boolean }> {
    const done = this.claimed.get(token);
    if (done) return this.test(done.name).then((connected) => ({ connected, waiting: false }));
    const exp = this.invites.get(token);
    return { connected: null, waiting: !!exp && exp > Date.now() };
  }

  async test(name: string): Promise<ComputerStatus> {
    const c = this.list().find((x) => x.name === name);
    if (!c) throw new HttpError(404, "No such computer");
    const p = Bun.spawn(["ssh", "-F", this.configPath, c.name, "echo ok"], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(), 12_000);
    const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
    clearTimeout(timer);
    const online = code === 0 && out.trim() === "ok";
    return { ...c, online, detail: online ? "Connected" : err.trim().split("\n").pop() || "Not reachable. Is it awake, on Tailscale, with Remote Login on?" };
  }

  async statuses(): Promise<ComputerStatus[]> {
    return Promise.all(this.list().map((c) => this.test(c.name)));
  }

  /**
   * Shell run on the computer to delete the hub's key from authorized_keys. The filtered copy is written beside the
   * file and swapped in only if filtering succeeded, so a read error can never wipe the other keys. Exits 0 only if
   * the key is gone afterwards.
   */
  revokeScript(): string {
    const key = this.publicKey().split(/\s+/).slice(0, 2).join(" "); // type + key, without the comment
    return [
      `f="$HOME/.ssh/authorized_keys"`,
      `[ -f "$f" ] || exit 0`,
      `t="$f.crosstalk.$$"`,
      // grep exits 1 when no lines are left (ours was the only key), which is fine; 2 or more means it failed.
      `grep -vF '${key}' "$f" > "$t"; s=$?`,
      `if [ "$s" -gt 1 ]; then rm -f "$t"; exit 2; fi`,
      `chmod 600 "$t" && mv -f "$t" "$f" || { rm -f "$t"; exit 3; }`,
      `! grep -qF '${key}' "$f"`,
    ].join("\n");
  }

  /**
   * Disconnects a computer: first signs in once more to delete the hub's key from its authorized_keys, so the
   * key no longer works there, then forgets it. If the computer can't be reached, it's still forgotten and the
   * caller is told access may remain.
   */
  async remove(name: string): Promise<{ revoked: boolean }> {
    const c = this.list().find((x) => x.name === name);
    if (!c) return { revoked: true };
    const p = Bun.spawn(["ssh", "-F", this.configPath, c.name, this.revokeScript()], { stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => p.kill(), 12_000);
    const revoked = (await p.exited) === 0;
    clearTimeout(timer);
    this.save(this.list().filter((x) => x.name !== name));
    return { revoked };
  }

  /** How agents are told about connected computers (added to their room briefing). */
  briefing(): string | null {
    const list = this.list();
    if (!list.length) return null;
    const ssh = `ssh -F "${this.configPath}"`;
    const how = list.map((c) =>
      c.os === "windows"
        ? `${c.name} (${c.label}, Windows): ${ssh} ${c.name} "<command>" runs it in cmd.exe; for PowerShell use ${ssh} ${c.name} "powershell -NoProfile -Command <command>". List what's plugged in with: pnputil /enum-devices /connected /class USB`
        : c.os === "linux"
          ? `${c.name} (${c.label}, Linux): ${ssh} ${c.name} 'bash -lc "<command>"' (a login shell, so the user's PATH applies). List everything plugged in with lsusb`
          : `${c.name} (${c.label}): ${ssh} ${c.name} '$SHELL -lc "<command>"' (the login shell loads the tools installed there, like adb and Homebrew's). List everything plugged in with system_profiler SPUSBHostDataType`,
    );
    return `- Other computers you can run commands on. ${how.join(". ")}. Devices plugged into those computers are reachable that way: an Android phone with adb, an iPhone with xcrun devicectl (Mac). Phones in modes adb can't see (like Qualcomm emergency download, USB 05c6:9008) still show in the list of what's plugged in. Say what you're about to run there.`;
  }

}
