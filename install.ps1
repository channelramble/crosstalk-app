# Crosstalk: one-line install for an always-on Windows PC. Open PowerShell and run:
#
#   irm https://raw.githubusercontent.com/channelramble/crosstalk-app/main/install.ps1 | iex
#
# The hub runs on Linux, so on Windows it runs inside WSL2 (Windows' built-in Linux, from Microsoft). This script:
#   1. installs WSL2 and Ubuntu if they aren't there yet (asks for administrator rights; Windows may need a restart,
#      after which you run the same line again)
#   2. turns on systemd in Ubuntu, so the hub runs as a background service there
#   3. installs Tailscale inside Ubuntu if it's missing (you sign in once, with the link it prints)
#   4. installs the hub inside Ubuntu with the Mac/Linux one-liner (install.sh), which prints your pairing code
#   5. keeps Ubuntu running while you're logged in to Windows (a scheduled task), so the hub stays reachable
#   6. offers to stop the PC from sleeping while it's plugged in
#
# Run it again any time to update. Options, as environment variables before the line:
#   $env:CROSSTALK_DISTRO = "Ubuntu-24.04"   which WSL distribution to use (default: Ubuntu-24.04)
#   $env:CROSSTALK_KEEP_AWAKE = "no"         don't ask about sleep
$ErrorActionPreference = "Stop"

$Repo = if ($env:CROSSTALK_REPO) { $env:CROSSTALK_REPO } else { "channelramble/crosstalk-app" }
$Distro = if ($env:CROSSTALK_DISTRO) { $env:CROSSTALK_DISTRO } else { "Ubuntu-24.04" }
$OneLiner = "irm https://raw.githubusercontent.com/$Repo/main/install.ps1 | iex"
$TaskName = "Crosstalk hub (WSL)"

function Say($text) { Write-Host "  $text" }
function Step($text) { Write-Host ""; Write-Host $text -ForegroundColor White }
function Warn($text) { Write-Host "  ! $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host "  x $text" -ForegroundColor Red; throw $text }
function IsAdmin { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
# wsl.exe prints UTF-16; read its output as text.
function Wsl([string[]]$WslArgs) {
  $old = [Console]::OutputEncoding
  [Console]::OutputEncoding = [Text.Encoding]::Unicode
  try { & wsl.exe @WslArgs 2>&1 | Out-String } finally { [Console]::OutputEncoding = $old }
}
function HasDistro { (Wsl @("--list", "--quiet")) -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -eq $Distro } }

Write-Host "Crosstalk: setting up the hub on this PC" -ForegroundColor White

$build = [Environment]::OSVersion.Version.Build
if ($build -lt 19041) { Fail "WSL2 needs Windows 10 version 2004 or newer, or Windows 11. Update Windows, then run this again." }

# 1. WSL2 and Ubuntu
Step "1/6  WSL2 and Ubuntu"
$wslReady = $false
try { $null = Wsl @("--status"); $wslReady = ($LASTEXITCODE -eq 0) } catch { $wslReady = $false }
if (-not $wslReady -or -not (HasDistro)) {
  if (-not (IsAdmin)) {
    Say "Installing WSL needs administrator rights. A new PowerShell window opens as administrator to do it."
    Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoExit", "-Command", $OneLiner
    return
  }
  Say "Installing WSL2 and $Distro (this downloads about 1 GB)..."
  & wsl.exe --install -d $Distro
  if ($LASTEXITCODE -ne 0) { Fail "WSL didn't install. If it asks you to turn on virtualization in your PC's firmware (BIOS), do that and run this again." }
  if (-not (HasDistro)) {
    Warn "Windows needs a restart to finish installing WSL. Restart, then open PowerShell and run the same line again:"
    Say $OneLiner
    return
  }
}
# First start of Ubuntu: it asks you to choose a Linux username and password (keep them: sudo asks for that password).
$user = (Wsl @("-d", $Distro, "--", "whoami")).Trim()
if (-not $user -or $user -eq "root") {
  Say "Ubuntu starts for the first time now. Choose a username and password for Linux when it asks, then type 'exit'."
  & wsl.exe -d $Distro
  $user = (Wsl @("-d", $Distro, "--", "whoami")).Trim()
  if (-not $user -or $user -eq "root") { Fail "Ubuntu has no user of its own yet. Run 'wsl -d $Distro', create one, then run this again." }
}
Say "$Distro is ready (Linux user: $user) ✓"

# 2. systemd, so the hub runs as a service
Step "2/6  Background services in Ubuntu"
$conf = Wsl @("-d", $Distro, "-u", "root", "--", "cat", "/etc/wsl.conf")
if ($conf -notmatch "systemd\s*=\s*true") {
  $null = Wsl @("-d", $Distro, "-u", "root", "--", "sh", "-c", "printf '\n[boot]\nsystemd=true\n' >> /etc/wsl.conf")
  & wsl.exe --terminate $Distro | Out-Null
  Say "Turned on systemd ✓"
} else { Say "systemd is on ✓" }

# 3. Tailscale inside Ubuntu: your phone reaches the hub through it
Step "3/6  Tailscale"
$ts = (Wsl @("-d", $Distro, "--", "sh", "-c", "command -v tailscale || true")).Trim()
if (-not $ts) {
  Say "Installing Tailscale in Ubuntu (it asks for your Linux password)..."
  & wsl.exe -d $Distro -- sh -c "curl -fsSL https://tailscale.com/install.sh | sh"
}
$up = Wsl @("-d", $Distro, "--", "sh", "-c", "tailscale status >/dev/null 2>&1 && echo up || echo down")
if ($up -notmatch "up") {
  Say "Sign Ubuntu in to your tailnet: open the link it prints, on any device."
  & wsl.exe -d $Distro -- sh -c "sudo tailscale up --operator=`$USER"
}
Say "Tailscale ✓  (in the Tailscale admin console, turn on HTTPS certificates under DNS if you haven't)"

# 4. The hub itself, with the Mac/Linux installer
Step "4/6  The Crosstalk hub"
& wsl.exe -d $Distro -- bash -lc "curl -fsSL https://raw.githubusercontent.com/$Repo/main/install.sh | bash"
if ($LASTEXITCODE -ne 0) { Fail "The hub didn't install inside Ubuntu (see above). Fix what it says, then run this again." }

# 5. Keep Ubuntu running while you're logged in: WSL stops a distribution nothing is using, and the hub with it.
Step "5/6  Keeping the hub running"
$action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument "--headless wsl.exe -d $Distro --exec sleep infinity"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Keeps WSL running so the Crosstalk hub stays reachable." -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Say "Starts when you log in to Windows ✓  (the hub runs while you're logged in; turn on automatic sign-in for an unattended PC)"

# 6. Sleep
Step "6/6  Sleep"
if ($env:CROSSTALK_KEEP_AWAKE -ne "no") {
  $answer = Read-Host "  Keep this PC awake while it's plugged in, so your agents keep working? [Y/n]"
  if ($answer -eq "" -or $answer -match "^[Yy]") {
    & powercfg.exe /change standby-timeout-ac 0
    & powercfg.exe /change hibernate-timeout-ac 0
    Say "This PC no longer sleeps while plugged in ✓"
  } else { Say "Left as it is: agents stop while the PC sleeps." }
}

Write-Host ""
Write-Host "Done. Open the address printed above on your phone and enter the pairing code." -ForegroundColor Green
Say "Lost the code? Run:  wsl -d $Distro -- ~/.local/bin/crosstalk-hub pair"
