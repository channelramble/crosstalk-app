#!/bin/sh
# Try Crosstalk Hub by hand without touching the real hub: a temporary home with a test hub on a spare port, run by a
# stand-in launchctl (scripts/fake-launchctl.sh) that Start, Stop and Restart drive, and the app pointed at both. Its
# Start at login is a marker file there, and Install puts the app's own hub into the temporary home. Quit the app from
# its menu to end the trial: the test hub, a waiting restart and the temporary home go with it.
#   native/hub-tray/scripts/try-fake-service.sh                  a hub that's set up and running
#   native/hub-tray/scripts/try-fake-service.sh --not-installed  no hub yet, to try Install
#   ... --hidden                                                 start with only the menu bar icon
#   APP=native/hub-tray/target/debug/crosstalk-hub-app ...       another build of the app
# macOS only. Start it from Terminal at the Mac, not from an agent inside the hub: macOS counts a process's privacy
# requests as its starter's, so the app's (WebKit only preflights, which never ask) would be counted as the hub's.
# Meanwhile `/usr/bin/log stream --predicate 'subsystem == "com.apple.TCC"'` shows any privacy dialog.
set -e
cd "$(dirname "$0")/.."
HERE="$(pwd)"
ROOT="$(cd ../.. && pwd)"
LABEL=com.crosstalk.hub.trial
APP="${APP:-$HERE/target/release/bundle/macos/Crosstalk Hub.app/Contents/MacOS/crosstalk-hub-app}"
[ -x "$APP" ] || { echo "Build the app first (scripts/build-macos.sh), or set APP." >&2; exit 1; }
INSTALLED=1
HIDDEN=""
for a in "$@"; do
  case "$a" in
    --not-installed) INSTALLED="" ;;
    --hidden) HIDDEN=--hidden ;;
  esac
done
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
TRIAL="$(cd "$(mktemp -d -t crosstalk-hub-trial)" && pwd -P)"
TH="$TRIAL/home"
mkdir -p "$TH/.crosstalk" "$TRIAL/bin"
cp "$HERE/scripts/fake-launchctl.sh" "$TRIAL/bin/launchctl"
chmod +x "$TRIAL/bin/launchctl"
PORT=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
[ "$PORT" != 7420 ] || PORT=7431
# The trial's own port, never the real hub's: the app (and so the installer) reads it from here.
printf '{ "port": %s }\n' "$PORT" >"$TH/.crosstalk/config.json"

cleanup() {
  HOME="$TH" "$TRIAL/bin/launchctl" bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  # A restart the trial left waiting runs in the trial's home.
  for pid in $(pgrep -f 'restart-when-idle\.sh' || true); do
    case "$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" in
      "$TRIAL"/*) kill -TERM -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true ;;
    esac
  done
  rm -rf "$TRIAL"
}
trap cleanup EXIT INT TERM

if [ -n "$INSTALLED" ]; then
  # Set up as install-macos.sh would, with the hub run from the source.
  mkdir -p "$TH/.local/bin" "$TH/Library/LaunchAgents"
  printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$BUN" "$ROOT/hub/src/main.ts" >"$TH/.local/bin/crosstalk-hub"
  chmod +x "$TH/.local/bin/crosstalk-hub"
  cat >"$TH/Library/LaunchAgents/$LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$TH/.local/bin/crosstalk-hub</string><string>serve</string></array>
  <key>StandardOutPath</key><string>$TH/Library/Logs/Crosstalk/hub.log</string>
  <key>StandardErrorPath</key><string>$TH/Library/Logs/Crosstalk/hub.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$TH</string>
    <key>LANG</key><string>en_US.UTF-8</string>
    <key>CROSSTALK_PORT</key><string>$PORT</string>
    <key>CROSSTALK_HOST</key><string>127.0.0.1</string>
  </dict>
</dict>
</plist>
EOF
  HOME="$TH" "$TRIAL/bin/launchctl" bootstrap "gui/$(id -u)" "$TH/Library/LaunchAgents/$LABEL.plist"
fi

if [ -n "$INSTALLED" ]; then STATE="set up and running"; else STATE="not installed"; fi
echo "Trial in $TRIAL: test hub on port $PORT as $LABEL, $STATE."
echo "What the app asked the stand-in launchctl: $TRIAL/state/calls.log"
echo "Quit Crosstalk Hub from its menu to end the trial."
env -i HOME="$TH" PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG=en_US.UTF-8 TMPDIR="${TMPDIR:-/tmp}" \
  CROSSTALK_HUB_APP_LAUNCHCTL="$TRIAL/bin/launchctl" CROSSTALK_HUB_APP_LABEL="$LABEL" "$APP" $HIDDEN
