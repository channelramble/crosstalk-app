#!/usr/bin/env bash
# Crosstalk for macOS: installs it, or updates it, on the Mac your agents work on.
#
#   ./install-macos.sh                  from ./crosstalk-hub-darwin-<arch> next to this script
#   ./install-macos.sh /path/to/binary  from a specific binary
#   ./install-macos.sh --uninstall      stop and remove the background service (your data in ~/.crosstalk stays)
#
# Options (or environment variables):
#   --no-power       don't change sleep settings (CROSSTALK_NO_POWER=1)
#   --no-tailscale   don't publish with `tailscale serve` (CROSSTALK_NO_TAILSCALE=1)
#   --pair           show a pairing code at the end of an update too (a first install always does)
#   CROSSTALK_PORT   the port (default 7420)
#
# What it does:
#   1. puts Crosstalk at ~/.local/bin/crosstalk-hub
#   2. runs it as a LaunchAgent in your login session, so agents can use Xcode, the Simulator and your signing
#      keychain (a system daemon can't); it starts when you log in and comes back if it stops
#   3. keeps the Mac awake and restarts it after a power cut (asks for your password once)
#   4. publishes it to your own devices over HTTPS with `tailscale serve`
#   5. first time: shows a code (and its QR code) to pair your phone, and opens Crosstalk on this Mac
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
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die() { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS. On Linux, use install.sh."

# A first install ends with pairing; an update just says it's done.
FIRST=""
[ -f "${CROSSTALK_HOME:-$HOME/.crosstalk}/crosstalk.db" ] || FIRST=1
PAIR=""
SRC=""
UNINSTALL=""
for a in "$@"; do
  case "$a" in
    --uninstall) UNINSTALL=1 ;;
    --no-power) NO_POWER=1 ;;
    --no-tailscale) NO_TAILSCALE=1 ;;
    --pair) PAIR=1 ;;
    -h | --help) sed -n '2,20p' "$0"; exit 0 ;;
    *) SRC="$a" ;;
  esac
done

# Tailscale's command: on the PATH, or inside its app (CROSSTALK_TAILSCALE_APP says where else to look: a test names a
# place with nothing in it, so it can never reach this Mac's real Tailscale).
TS_APP="${CROSSTALK_TAILSCALE_APP:-/Applications/Tailscale.app/Contents/MacOS/Tailscale}"
tailscale_cli() {
  if command -v tailscale >/dev/null 2>&1; then command -v tailscale
  elif [ -x "$TS_APP" ]; then echo "$TS_APP"
  fi
}

if [ -n "$UNINSTALL" ]; then
  bold "Removing Crosstalk's background service"
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  TS="$(tailscale_cli)"
  if [ -n "$TS" ] && [ -z "$NO_TAILSCALE" ]; then "$TS" serve --https=443 off >/dev/null 2>&1 || true; fi
  ok "Removed. Your chats and settings are still in ~/.crosstalk, and the program in $BIN."
  exit 0
fi

case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) die "Unsupported CPU: $(uname -m)" ;;
esac
SRC="${SRC:-$HERE/crosstalk-hub-darwin-$ARCH}"
[ -f "$SRC" ] || die "Crosstalk's program wasn't found at $SRC"

WAS="$([ -x "$BIN" ] && "$BIN" version 2>/dev/null || true)"
bold "Crosstalk"
mkdir -p "$BIN_DIR" "$LOG_DIR"
install -m 755 "$SRC" "$BIN.new"
xattr -c "$BIN.new" 2>/dev/null || true             # drop quarantine if it was downloaded
# macOS remembers what Crosstalk may open (folders, drives) by its signature. A signing identity keeps that across
# updates; an ad-hoc signature is new with every build, so after an update macOS may ask again on the Mac's screen.
SIGN="${SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null | awk -F'"' '/Apple Development|Developer ID Application/ { print $2; exit }')}"
if [ -z "$SIGN" ] || ! codesign --force --sign "$SIGN" --identifier com.crosstalk.hub "$BIN.new" >/dev/null 2>&1; then
  codesign --force --sign - --identifier com.crosstalk.hub "$BIN.new" >/dev/null 2>&1 || true   # Apple silicon needs a valid (ad-hoc) signature
fi
mv -f "$BIN.new" "$BIN"
NOW="$("$BIN" version)"
if [ -z "$WAS" ]; then ok "Installed version $NOW"
elif [ "$WAS" = "$NOW" ]; then ok "Version $NOW (the same as before)"
else ok "Updated from $WAS to $NOW"; fi

# Xcode, where there is one: agents build with it through DEVELOPER_DIR. Said only when it needs something.
DEV_DIR=""
if [ -d /Applications/Xcode.app ]; then
  DEV_DIR="/Applications/Xcode.app/Contents/Developer"
  XV="$(DEVELOPER_DIR=$DEV_DIR xcodebuild -version 2>/dev/null | head -1 || true)"
  # `xcodebuild -version` works before the license is accepted; `-license check` doesn't (and neither do git, clang or simctl).
  if [ -z "$XV" ]; then warn "Xcode hasn't finished setting up: open it once, so agents can build with it."
  elif ! DEVELOPER_DIR=$DEV_DIR xcodebuild -license check >/dev/null 2>&1; then warn "Xcode's license isn't accepted yet, so agents can't build with it: sudo xcodebuild -license accept"
  fi
fi
command -v git >/dev/null 2>&1 || warn "git isn't installed (agents use it all the time). Typing 'git' in Terminal offers to install it."

PUBLIC_URL=""
TS="$(tailscale_cli)"
if [ -z "$NO_TAILSCALE" ] && [ -n "$TS" ] && "$TS" status >/dev/null 2>&1; then
  DNS="$("$TS" status --json 2>/dev/null | plutil -extract Self.DNSName raw -o - - 2>/dev/null | sed 's/\.$//' || true)"
  [ -n "$DNS" ] && PUBLIC_URL="https://$DNS"
fi

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
  ok "Running. It starts by itself when you log in."
else
  die "Crosstalk didn't start. Its log says why: $LOG_DIR/hub.log"
fi

# Awake, so agents can work and your phone can reach it while you're away. Asked once: a Mac that's set already isn't asked again.
if [ -z "$NO_POWER" ]; then
  if pmset -g 2>/dev/null | grep -Eq '^ *sleep +0( |$)' && pmset -g 2>/dev/null | grep -Eq '^ *autorestart +1'; then
    ok "This Mac stays awake."
  else
    info "Keeping this Mac awake, so it's there when you're away. macOS asks for your Mac password once:"
    if sudo pmset -a sleep 0 disksleep 0 womp 1 autorestart 1 powernap 0; then
      ok "This Mac stays awake (its display can still sleep)."
    else
      warn "Couldn't change the sleep settings. Turn on System Settings → Energy → Prevent automatic sleeping."
    fi
  fi
  AUTO="$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || true)"
  if [ "$AUTO" != "$(id -un)" ]; then
    warn "After a restart, Crosstalk starts once you log in. To have it back by itself: System Settings → Users & Groups → Automatically log in as $(id -un)."
  fi
fi

# Your own devices reach it over Tailscale, and nobody else.
REACH=""
if [ -n "$NO_TAILSCALE" ]; then
  PUBLIC_URL=""
elif [ -n "$PUBLIC_URL" ]; then
  SERVE=("$TS" serve --bg --https=443 "http://127.0.0.1:$PORT")
  CERT="$("$TS" status --json 2>/dev/null | plutil -extract CertDomains.0 raw -o - - 2>/dev/null || true)"
  if [ -z "$CERT" ] && [ ! -t 1 ]; then
    # Without HTTPS certificates, `tailscale serve` prints a link to turn them on and waits for it,
    # which would hang a run nobody is watching.
    warn "One switch is still off in Tailscale: open https://login.tailscale.com/admin/dns, turn on HTTPS Certificates, then run this again."
  elif "${SERVE[@]}" >/dev/null; then
    ok "Your devices reach it at $PUBLIC_URL (only yours: it's on your Tailscale network)."
    REACH=1
  else
    warn "Tailscale couldn't publish it. Open https://login.tailscale.com/admin/dns, turn on HTTPS Certificates, then run this again."
  fi
elif [ -n "$TS" ]; then
  warn "Tailscale is installed but not signed in. Open Tailscale, sign in, then run this again so your phone can reach this Mac."
else
  warn "Your phone can't reach this Mac yet. Install Tailscale here and on the phone (https://tailscale.com/download), sign in to both, then run this again."
fi

LOCAL="http://127.0.0.1:$PORT"
echo
if [ -n "$FIRST" ] || [ -n "$PAIR" ]; then
  if [ -n "$REACH" ]; then
    bold "Pair your phone"
    # The code, and under it a QR code that carries it: scanning it opens Crosstalk on the phone, ready to pair.
    "$BIN" pair 60 --url "$PUBLIC_URL" | sed 's/^/  /'
    echo
  fi
  # On this Mac too, when someone is at it: Crosstalk opens in the browser with a code of its own filled in.
  if [ -t 1 ] && [ -z "${SSH_CONNECTION:-}" ] && [ -z "${CROSSTALK_NO_OPEN:-}" ]; then
    HERE_CODE="$("$BIN" pair 60 | sed -n 's/^Pairing code: \([A-Z0-9-]*\).*/\1/p')"
    if [ -n "$HERE_CODE" ] && open "$LOCAL/#pair=$HERE_CODE" 2>/dev/null; then
      info "Crosstalk is opening in your browser on this Mac: press Pair this device there, and sign in your agent."
    fi
  elif [ -z "$REACH" ]; then
    info "On this Mac, Crosstalk is at $LOCAL"
    "$BIN" pair 60 | sed 's/^/    /'
  fi
else
  info "To pair another device: Settings → This device → Pair a new device, or run: crosstalk-hub pair"
fi

# Crosstalk Hub, the menu-bar app (Crosstalk's status, Pair a phone and its log without a terminal), where this
# release has one for this Mac and someone is at it. An extra: nothing is said, and nothing fails, without it.
if [ -n "$FIRST" ] && [ -t 1 ] && [ -z "${SSH_CONNECTION:-}" ] && [ -z "${CROSSTALK_NO_APP:-}" ] && [ -n "${CROSSTALK_RELEASE_BASE:-}" ] && [ "$ARCH" = arm64 ] \
  && [ ! -d "/Applications/Crosstalk Hub.app" ] && [ ! -d "$HOME/Applications/Crosstalk Hub.app" ]; then
  APP_TMP="$(mktemp -d)"
  if curl -fsSL "$CROSSTALK_RELEASE_BASE/Crosstalk-Hub-macos-arm64.zip" -o "$APP_TMP/app.zip" 2>/dev/null \
    && curl -fsSL "$CROSSTALK_RELEASE_BASE/Crosstalk-Hub-macos-arm64.zip.sha256" -o "$APP_TMP/sum" 2>/dev/null \
    && [ "$(shasum -a 256 "$APP_TMP/app.zip" | cut -d' ' -f1)" = "$(cut -d' ' -f1 "$APP_TMP/sum")" ]; then
    APP_DIR=/Applications
    [ -w "$APP_DIR" ] || { APP_DIR="$HOME/Applications"; mkdir -p "$APP_DIR"; }
    if ditto -x -k "$APP_TMP/app.zip" "$APP_DIR" 2>/dev/null && open -g "$APP_DIR/Crosstalk Hub.app" 2>/dev/null; then
      ok "Crosstalk Hub is in your menu bar: Crosstalk's status, Pair a phone and its log, without a terminal."
    fi
  fi
  rm -rf "$APP_TMP"
fi
