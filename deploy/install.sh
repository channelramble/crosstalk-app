#!/usr/bin/env bash
# Crosstalk for Linux (systemd): installs it, or updates it, on the machine your agents work on.
#
#   ./install.sh                      from ./crosstalk-hub-linux-<arch> next to this script
#   ./install.sh /path/to/binary      from a specific binary
#   ./install.sh --uninstall          stop and remove the service (your data in ~/.crosstalk stays)
#   ./install.sh --pair               show a pairing code at the end of an update too (a first install always does)
#
# What it does:
#   1. puts Crosstalk at ~/.local/bin/crosstalk-hub
#   2. runs it as a systemd *user* service that starts with the machine and comes back if it stops
#   3. turns on "linger" so it runs with nobody logged in (asks for your password once)
#   4. publishes it to your own devices over HTTPS with `tailscale serve` (if Tailscale is installed)
#   5. first time: shows a code (and its QR code) to pair your phone
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
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die() { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "This installer is for Linux. On a Mac, run install-macos.sh instead."
WSL=""
grep -qi microsoft /proc/version 2>/dev/null && WSL=1
# Your own systemd (systemctl --user) has to answer. Just after this Linux started (Ubuntu inside Windows right after
# systemd was turned on, a machine just booted) it can take a few seconds to come up, so it gets ten.
SYSTEMD=""
if command -v systemctl >/dev/null; then
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if systemctl --user show-environment >/dev/null 2>&1; then SYSTEMD=1; break; fi
    # Without systemd as this Linux's first program, waiting changes nothing.
    [ "$(cat /proc/1/comm 2>/dev/null)" = "systemd" ] || break
    sleep 1
  done
fi
if [ -z "$SYSTEMD" ]; then
  if [ -n "$WSL" ] && [ "$(cat /proc/1/comm 2>/dev/null)" != "systemd" ]; then
    # Added to /etc/wsl.conf, never written over it: it may hold other settings (which user Ubuntu starts as).
    die "This Ubuntu inside Windows isn't running systemd yet. In it, run:  printf '\\n[boot]\\nsystemd=true\\n' | sudo tee -a /etc/wsl.conf   then in PowerShell:  wsl --shutdown   and run this again."
  fi
  die "Crosstalk runs as a systemd user service, and systemd isn't answering here (systemctl --user). Log in as yourself (not with su), then run this again."
fi

# A first install ends with pairing; an update just says it's done.
FIRST=""
[ -f "${CROSSTALK_HOME:-$HOME/.crosstalk}/crosstalk.db" ] || FIRST=1
PAIR=""
ARGS=()
for a in "$@"; do
  case "$a" in
    --pair) PAIR=1 ;;
    *) ARGS+=("$a") ;;
  esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

if [ "${1:-}" = "--uninstall" ]; then
  bold "Removing Crosstalk's background service"
  systemctl --user disable --now crosstalk-hub 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload
  if command -v tailscale >/dev/null; then tailscale serve --https=443 off 2>/dev/null || sudo tailscale serve --https=443 off 2>/dev/null || true; fi
  ok "Removed. Your chats and settings are still in ~/.crosstalk, and the program in $BIN."
  exit 0
fi

case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) die "Unsupported CPU: $(uname -m)" ;;
esac

SRC="${1:-$HERE/crosstalk-hub-linux-$ARCH}"
[ -f "$SRC" ] || die "Crosstalk's program wasn't found at $SRC"

WAS="$([ -x "$BIN" ] && "$BIN" version 2>/dev/null || true)"
bold "Crosstalk"
mkdir -p "$BIN_DIR"
install -m 755 "$SRC" "$BIN.new"
mv -f "$BIN.new" "$BIN"
NOW="$("$BIN" version)"
if [ -z "$WAS" ]; then ok "Installed version $NOW"
elif [ "$WAS" = "$NOW" ]; then ok "Version $NOW (the same as before)"
else ok "Updated from $WAS to $NOW"; fi
# How this machine installs a package, for the hints below.
pkg_install() {
  if command -v apt-get >/dev/null; then echo "sudo apt install -y $1"
  elif command -v dnf >/dev/null; then echo "sudo dnf install -y $1"
  elif command -v pacman >/dev/null; then echo "sudo pacman -S --noconfirm $1"
  elif command -v zypper >/dev/null; then echo "sudo zypper install -y $1"
  elif command -v apk >/dev/null; then echo "sudo apk add $1"
  else echo "install $1 with your package manager"; fi
}
command -v git >/dev/null || warn "git isn't installed, and agents use it all the time: $(pkg_install git)"

# This machine's name on your Tailscale network, when it's on one (read without python: a bare server may have none).
PUBLIC_URL=""
if [ -z "$NO_TAILSCALE" ] && command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then
  DNS="$(tailscale status --json 2>/dev/null | tr -d '\n' | sed -n 's/.*"Self"[^{]*{[^}]*"DNSName"[^"]*"\([^"]*\)".*/\1/p' | sed 's/\.$//' || true)"
  [ -n "$DNS" ] && PUBLIC_URL="https://$DNS"
fi

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
# Up when it answers (a slow disk takes a few seconds); without curl, when systemd says it runs.
UP=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if command -v curl >/dev/null; then curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && UP=1 && break
  elif systemctl --user is-active --quiet crosstalk-hub; then UP=1 && break; fi
  sleep 1
done
if [ -n "$UP" ]; then
  ok "Running. It starts by itself with this machine."
else
  die "Crosstalk didn't start. Its log says why: journalctl --user -u crosstalk-hub -n 50"
fi

if [ -n "$NO_LINGER" ]; then
  info "Not keeping it running when you're logged out (CROSSTALK_NO_LINGER)"
elif [ "$(loginctl show-user "$USER" --property=Linger --value 2>/dev/null)" != "yes" ]; then
  info "Keeping it running when you're logged out. Linux may ask for your password once:"
  if loginctl enable-linger "$USER" 2>/dev/null || sudo loginctl enable-linger "$USER"; then ok "It keeps running when you log out."
  else warn "couldn't enable linger; Crosstalk stops when you log out. Run: sudo loginctl enable-linger $USER"; fi
fi

# Your own devices reach it over Tailscale, and nobody else.
REACH=""
if [ -n "$NO_TAILSCALE" ]; then
  info "Not publishing it with Tailscale (CROSSTALK_NO_TAILSCALE)"
  PUBLIC_URL=""
elif [ -n "$PUBLIC_URL" ]; then
  if tailscale serve --bg --https=443 "http://127.0.0.1:$PORT" >/dev/null 2>&1 || sudo tailscale serve --bg --https=443 "http://127.0.0.1:$PORT" >/dev/null; then
    ok "Your devices reach it at $PUBLIC_URL (only yours: it's on your Tailscale network)."
    REACH=1
  else
    warn "tailscale serve failed. Run: sudo tailscale set --operator=$USER  and turn on HTTPS Certificates at https://login.tailscale.com/admin/dns, then run this again."
  fi
elif command -v tailscale >/dev/null; then
  warn "Tailscale is installed but not connected. Run: sudo tailscale up   then run this again so your phone can reach this machine."
else
  warn "Your phone can't reach this machine yet. Install Tailscale here and on the phone (https://tailscale.com/download), sign in to both, then run this again."
fi

LOCAL="http://127.0.0.1:$PORT"
echo
if [ -n "$FIRST" ] || [ -n "$PAIR" ]; then
  if [ -n "$REACH" ]; then
    bold "Pair your phone"
    # The code, and under it a QR code that carries it: scanning it opens Crosstalk on the phone, ready to pair.
    "$BIN" pair 60 --url "$PUBLIC_URL" | sed 's/^/  /'
  else
    info "On this machine, Crosstalk is at $LOCAL"
    "$BIN" pair 60 | sed 's/^/    /'
  fi
  # At a desktop, Crosstalk opens in the browser with a code of its own filled in.
  if [ -t 1 ] && [ -z "${SSH_CONNECTION:-}" ] && [ -z "${CROSSTALK_NO_OPEN:-}" ] && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null; then
    HERE_CODE="$("$BIN" pair 60 | sed -n 's/^Pairing code: \([A-Z0-9-]*\).*/\1/p')"
    if [ -n "$HERE_CODE" ] && xdg-open "$LOCAL/#pair=$HERE_CODE" >/dev/null 2>&1; then
      echo
      info "Crosstalk is opening in your browser here too: press Pair this device there, and sign in your agent."
    fi
  fi
else
  info "To pair another device: Settings → This device → Pair a new device, or run: crosstalk-hub pair"
fi
