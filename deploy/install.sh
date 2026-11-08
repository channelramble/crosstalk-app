#!/usr/bin/env bash
# Crosstalk hub installer for Linux (systemd).
#
#   ./install.sh                      install/update from ./crosstalk-hub-linux-<arch> next to this script
#   ./install.sh /path/to/binary      install/update from a specific binary
#   ./install.sh --uninstall          stop and remove the service (keeps ~/.crosstalk data)
#
# What it does:
#   1. copies the hub to ~/.local/bin/crosstalk-hub
#   2. installs a systemd *user* service that restarts on failure and starts at boot
#   3. enables "linger" so the service runs without anyone logged in (asks for sudo once)
#   4. publishes the hub on your tailnet with HTTPS via `tailscale serve` (if Tailscale is installed)
#   5. prints a one-time code to pair your first device
#
# CROSSTALK_PORT sets the port (default 7420). CROSSTALK_NO_LINGER=1 and CROSSTALK_NO_TAILSCALE=1 skip linger and
# `tailscale serve`, which change this computer's real settings (Crosstalk Hub's trials set both).
set -euo pipefail

PORT="${CROSSTALK_PORT:-7420}"
NO_LINGER="${CROSSTALK_NO_LINGER:-}"
NO_TAILSCALE="${CROSSTALK_NO_TAILSCALE:-}"
BIN_DIR="$HOME/.local/bin"
BIN="$BIN_DIR/crosstalk-hub"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/crosstalk-hub.service"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
die() { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "This installer is for Linux. On a Mac, run install-macos.sh instead."
command -v systemctl >/dev/null || die "systemd is required."

if [ "${1:-}" = "--uninstall" ]; then
  bold "Removing the Crosstalk hub service"
  systemctl --user disable --now crosstalk-hub 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload
  if command -v tailscale >/dev/null; then tailscale serve --https=443 off 2>/dev/null || sudo tailscale serve --https=443 off 2>/dev/null || true; fi
  info "Service removed. Your data is still in ~/.crosstalk and the binary in $BIN."
  exit 0
fi

case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) die "Unsupported CPU: $(uname -m)" ;;
esac

SRC="${1:-$HERE/crosstalk-hub-linux-$ARCH}"
[ -f "$SRC" ] || die "Hub binary not found at $SRC"

bold "1/5  Installing the hub"
mkdir -p "$BIN_DIR"
install -m 755 "$SRC" "$BIN.new"
mv -f "$BIN.new" "$BIN"
info "$BIN ($("$BIN" version))"

bold "2/5  Checking tools the agents need"
for tool in git curl; do
  if command -v "$tool" >/dev/null; then info "$tool ✓"; else warn "$tool is missing — install it (e.g. sudo apt install -y $tool)"; fi
done
if command -v npm >/dev/null; then info "npm ✓ (used to install Codex and Gemini CLI)"; else warn "npm is missing — Codex and Gemini CLI install through npm (sudo apt install -y nodejs npm)"; fi

PUBLIC_URL=""
if [ -z "$NO_TAILSCALE" ] && command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then
  DNS="$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
  [ -n "$DNS" ] && PUBLIC_URL="https://$DNS"
fi

bold "3/5  Installing the background service"
mkdir -p "$UNIT_DIR"
cat >"$UNIT" <<EOF
[Unit]
Description=Crosstalk hub (your coding agents, from any device)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$BIN serve
Restart=always
RestartSec=3
Environment=CROSSTALK_PORT=$PORT
Environment=CROSSTALK_HOST=127.0.0.1
Environment=PATH=$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.muse/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin
${PUBLIC_URL:+Environment=CROSSTALK_PUBLIC_URL=$PUBLIC_URL}
# Agents run as you, in your home directory; give them room to work.
LimitNOFILE=65536

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable crosstalk-hub >/dev/null
systemctl --user restart crosstalk-hub
sleep 1
if systemctl --user is-active --quiet crosstalk-hub; then
  info "running (systemctl --user status crosstalk-hub)"
else
  die "the service didn't start: journalctl --user -u crosstalk-hub -n 50"
fi

if [ -n "$NO_LINGER" ]; then
  info "Not keeping it running when you're logged out (CROSSTALK_NO_LINGER)"
elif [ "$(loginctl show-user "$USER" --property=Linger --value 2>/dev/null)" != "yes" ]; then
  info "Keeping the hub running when you're logged out (needs your password once)…"
  loginctl enable-linger "$USER" 2>/dev/null || sudo loginctl enable-linger "$USER" || warn "couldn't enable linger; the hub stops when you log out"
fi

bold "4/5  Publishing on your Tailscale network"
if [ -n "$NO_TAILSCALE" ]; then
  info "skipped (CROSSTALK_NO_TAILSCALE)"
  PUBLIC_URL="http://127.0.0.1:$PORT"
elif [ -n "$PUBLIC_URL" ]; then
  if tailscale serve --bg --https=443 "http://127.0.0.1:$PORT" >/dev/null 2>&1 || sudo tailscale serve --bg --https=443 "http://127.0.0.1:$PORT" >/dev/null; then
    info "$PUBLIC_URL (only your tailnet devices can reach it)"
  else
    warn "tailscale serve failed. Run: sudo tailscale set --operator=$USER  then rerun this script."
  fi
else
  warn "Tailscale isn't installed or connected. Install it (https://tailscale.com/download/linux), run 'sudo tailscale up', then rerun this script."
  PUBLIC_URL="http://127.0.0.1:$PORT"
fi

bold "5/5  Pair your first device"
sleep 1
CODE_LINE="$("$BIN" pair 60)"
echo
echo "    Open   $PUBLIC_URL"
echo "    $CODE_LINE"
echo
info "On your phone: open that address in Safari/Chrome → Share → Add to Home Screen."
info "Update later by running this script again with a newer binary."
