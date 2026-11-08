#!/usr/bin/env bash
# Crosstalk hub installer for macOS (e.g. an always-on Mac mini that builds iOS apps).
#
#   ./install-macos.sh                  install/update from ./crosstalk-hub-darwin-<arch> next to this script
#   ./install-macos.sh /path/to/binary  install/update from a specific binary
#   ./install-macos.sh --uninstall      stop and remove the background service (keeps ~/.crosstalk data)
#
# Options (or environment variables):
#   --no-power       don't change sleep settings (CROSSTALK_NO_POWER=1)
#   --no-tailscale   don't publish with `tailscale serve` (CROSSTALK_NO_TAILSCALE=1)
#   CROSSTALK_PORT   hub port (default 7420)
#
# What it does:
#   1. installs the hub to ~/.local/bin/crosstalk-hub
#   2. runs it as a LaunchAgent in your login session, so agents can use Xcode, the Simulator and your
#      signing keychain (a system daemon can't); it restarts if it crashes and starts when you log in
#   3. keeps the Mac awake and restarts it after a power cut (asks for your password once)
#   4. publishes the hub on your tailnet over HTTPS with `tailscale serve`
#   5. checks Xcode, Simulator runtimes, Homebrew and Node, and prints a pairing code
set -euo pipefail

PORT="${CROSSTALK_PORT:-7420}"
LABEL="${CROSSTALK_LABEL:-com.crosstalk.hub}"
NO_POWER="${CROSSTALK_NO_POWER:-}"
NO_TAILSCALE="${CROSSTALK_NO_TAILSCALE:-}"
BIN_DIR="$HOME/.local/bin"
BIN="$BIN_DIR/crosstalk-hub"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/Crosstalk"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAIN="gui/$(id -u)"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
die() { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS. On Linux, use install.sh."

SRC=""
UNINSTALL=""
for a in "$@"; do
  case "$a" in
    --uninstall) UNINSTALL=1 ;;
    --no-power) NO_POWER=1 ;;
    --no-tailscale) NO_TAILSCALE=1 ;;
    -h | --help) sed -n '2,22p' "$0"; exit 0 ;;
    *) SRC="$a" ;;
  esac
done

tailscale_cli() {
  if command -v tailscale >/dev/null 2>&1; then command -v tailscale
  elif [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then echo /Applications/Tailscale.app/Contents/MacOS/Tailscale
  fi
}

if [ -n "$UNINSTALL" ]; then
  bold "Removing the Crosstalk hub service"
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  TS="$(tailscale_cli)"
  if [ -n "$TS" ] && [ -z "$NO_TAILSCALE" ]; then "$TS" serve --https=443 off >/dev/null 2>&1 || true; fi
  info "Service removed. Your data is still in ~/.crosstalk and the binary in $BIN."
  exit 0
fi

case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) die "Unsupported CPU: $(uname -m)" ;;
esac
SRC="${SRC:-$HERE/crosstalk-hub-darwin-$ARCH}"
[ -f "$SRC" ] || die "Hub binary not found at $SRC"

bold "1/5  Installing the hub"
mkdir -p "$BIN_DIR" "$LOG_DIR"
install -m 755 "$SRC" "$BIN.new"
xattr -c "$BIN.new" 2>/dev/null || true             # drop quarantine if it was downloaded
# macOS remembers what the hub may open (folders, drives) by its signature. A signing identity keeps that across
# updates; an ad-hoc signature is new with every build, so after each update macOS asks again on the Mac's screen.
SIGN="${SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Apple Development|Developer ID Application/ { print $2; exit }')}"
if [ -n "$SIGN" ] && codesign --force --sign "$SIGN" --identifier com.crosstalk.hub "$BIN.new" >/dev/null 2>&1; then
  info "Signed as $SIGN"
else
  codesign --force --sign - --identifier com.crosstalk.hub "$BIN.new" >/dev/null 2>&1 || true   # Apple silicon needs a valid (ad-hoc) signature
  warn "Signed ad hoc: after each update macOS may ask again about folders and drives. Set SIGN_IDENTITY to a signing identity to keep its answers."
fi
mv -f "$BIN.new" "$BIN"
info "$BIN ($("$BIN" version))"

bold "2/5  Checking what the agents need"
DEV_DIR=""
if [ -d /Applications/Xcode.app ]; then
  DEV_DIR="/Applications/Xcode.app/Contents/Developer"
  XV="$(DEVELOPER_DIR=$DEV_DIR xcodebuild -version 2>/dev/null | head -1 || true)"
  # `xcodebuild -version` works before the license is accepted; `-license check` doesn't (and neither do git, clang or simctl).
  if [ -z "$XV" ]; then warn "xcodebuild didn't run. Open Xcode once to finish its setup."
  elif ! DEVELOPER_DIR=$DEV_DIR xcodebuild -license check >/dev/null 2>&1; then warn "$XV is installed, but its license isn't accepted yet: sudo xcodebuild -license accept"
  else info "$XV ✓"; fi
  if [ "$(xcode-select -p 2>/dev/null)" != "$DEV_DIR" ]; then
    info "xcode-select points at $(xcode-select -p 2>/dev/null || echo nothing); the hub uses Xcode via DEVELOPER_DIR instead."
  fi
  if DEVELOPER_DIR=$DEV_DIR xcrun simctl list runtimes 2>/dev/null | grep -q "^iOS"; then
    info "iOS Simulator runtime ✓"
  else
    warn "No iOS Simulator runtime yet. Install one: xcodebuild -downloadPlatform iOS"
  fi
  if ! security find-identity -v -p codesigning 2>/dev/null | grep -q "Apple Development\|Apple Distribution"; then
    warn "No Apple signing identity in your keychain. Open Xcode → Settings → Accounts and sign in with your developer account."
  else
    info "Code signing identity ✓"
  fi
else
  warn "Xcode isn't installed. Get it from the App Store; agents need it to build iOS apps."
fi
for tool in git curl; do
  if command -v "$tool" >/dev/null 2>&1; then info "$tool ✓"; else warn "$tool is missing"; fi
done
BREW=""
[ -x /opt/homebrew/bin/brew ] && BREW=/opt/homebrew/bin/brew
[ -z "$BREW" ] && [ -x /usr/local/bin/brew ] && BREW=/usr/local/bin/brew
if [ -n "$BREW" ]; then info "Homebrew ✓"; else warn "Homebrew isn't installed (https://brew.sh). It's the easiest way to get Node and gh."; fi
if PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" command -v npm >/dev/null 2>&1; then info "npm ✓ (used to install Codex and Gemini CLI)"; else warn "npm is missing — Codex and Gemini CLI install through it: brew install node"; fi

PUBLIC_URL=""
TS="$(tailscale_cli)"
if [ -z "$NO_TAILSCALE" ] && [ -n "$TS" ] && "$TS" status >/dev/null 2>&1; then
  DNS="$("$TS" status --json 2>/dev/null | plutil -extract Self.DNSName raw -o - - 2>/dev/null | sed 's/\.$//' || true)"
  [ -n "$DNS" ] && PUBLIC_URL="https://$DNS"
fi

bold "3/5  Installing the background service"
mkdir -p "$(dirname "$PLIST")"
AGENT_PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.muse/bin:$HOME/.bun/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
{
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>WorkingDirectory</key><string>$HOME</string>
  <key>StandardOutPath</key><string>$LOG_DIR/hub.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/hub.log</string>
  <key>SoftResourceLimits</key><dict><key>NumberOfFiles</key><integer>65536</integer></dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$AGENT_PATH</string>
    <key>HOME</key><string>$HOME</string>
    <key>LANG</key><string>en_US.UTF-8</string>
    <key>CROSSTALK_PORT</key><string>$PORT</string>
    <key>CROSSTALK_HOST</key><string>127.0.0.1</string>
EOF
  [ -n "${CROSSTALK_HOME:-}" ] && printf '    <key>CROSSTALK_HOME</key><string>%s</string>\n' "$CROSSTALK_HOME"
  [ -n "$PUBLIC_URL" ] && printf '    <key>CROSSTALK_PUBLIC_URL</key><string>%s</string>\n' "$PUBLIC_URL"
  [ -n "$DEV_DIR" ] && printf '    <key>DEVELOPER_DIR</key><string>%s</string>\n' "$DEV_DIR"
  cat <<EOF
  </dict>
</dict>
</plist>
EOF
} >"$PLIST"
plutil -lint "$PLIST" >/dev/null || die "generated plist is invalid: $PLIST"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST" || die "launchctl couldn't load $PLIST. Are you logged in at the Mac's screen (or via Screen Sharing)?"
launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 1
done
if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  info "running (logs: $LOG_DIR/hub.log)"
else
  die "the hub didn't start; see $LOG_DIR/hub.log"
fi

bold "4/5  Keeping the Mac awake"
if [ -n "$NO_POWER" ]; then
  info "skipped (--no-power)"
else
  info "Turning off system sleep and enabling restart-after-power-failure (needs your password once)…"
  if sudo pmset -a sleep 0 disksleep 0 womp 1 autorestart 1 powernap 0; then
    info "the Mac will stay awake; the display can still sleep"
  else
    warn "couldn't change sleep settings; set System Settings → Energy → Prevent automatic sleeping"
  fi
  AUTO="$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || true)"
  if [ "$AUTO" = "$(id -un)" ]; then
    info "automatic login ✓ (the hub comes back by itself after a restart)"
  else
    warn "Turn on automatic login so the hub restarts after a reboot: System Settings → Users & Groups → Automatically log in as $(id -un). (Not available while FileVault is on.)"
  fi
fi

bold "5/5  Publishing on your Tailscale network"
if [ -n "$NO_TAILSCALE" ]; then
  info "skipped (--no-tailscale)"
  PUBLIC_URL="http://127.0.0.1:$PORT"
elif [ -n "$PUBLIC_URL" ]; then
  SERVE=("$TS" serve --bg --https=443 "http://127.0.0.1:$PORT")
  CERT="$("$TS" status --json 2>/dev/null | plutil -extract CertDomains.0 raw -o - - 2>/dev/null || true)"
  if [ -z "$CERT" ] && [ ! -t 1 ]; then
    # Without HTTPS certificates, `tailscale serve` prints a link to turn them on and waits for it,
    # which would hang a non-interactive run.
    warn "HTTPS certificates aren't on for your tailnet yet. Turn them on (admin console → DNS → HTTPS Certificates), then run:"
    warn "  ${SERVE[*]}"
  elif "${SERVE[@]}"; then
    info "$PUBLIC_URL (only your tailnet devices can reach it)"
  else
    warn "tailscale serve failed — make sure HTTPS certificates are enabled for your tailnet (admin console → DNS → HTTPS), then rerun."
  fi
else
  warn "Tailscale isn't installed or connected. Install it (brew install --cask tailscale, or the App Store), sign in, then rerun."
  PUBLIC_URL="http://127.0.0.1:$PORT"
fi

echo
CODE_LINE="$("$BIN" pair 60)"
echo "    Open   $PUBLIC_URL"
echo "    $CODE_LINE"
echo
info "Update later by running this script again with a newer binary."
info "Stop/start: launchctl kickstart -k $DOMAIN/$LABEL   ·   remove: $0 --uninstall"
