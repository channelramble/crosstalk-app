#!/usr/bin/env bash
# Crosstalk: one-line install for the always-on Mac or Linux machine your agents work on.
#
#   curl -fsSL https://raw.githubusercontent.com/channelramble/crosstalk-app/main/install.sh | bash
#
# It downloads the newest release for this machine, checks it against the release's SHA256SUMS, and runs the
# platform installer that comes with it (install-macos.sh or install-linux.sh). Run it again any time to update.
# Pass options through after `bash -s --`, e.g.  ... | bash -s -- --no-power
# Windows: use install.ps1 (it runs this inside WSL).
set -euo pipefail

REPO="${CROSSTALK_REPO:-channelramble/crosstalk-app}"
VERSION="${CROSSTALK_VERSION:-latest}"   # or a tag like v0.6.8

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die() { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) OS=darwin; SETUP=install-macos.sh ;;
  Linux) OS=linux; SETUP=install-linux.sh ;;
  *) die "This is for macOS and Linux. On Windows, open PowerShell and run: irm https://raw.githubusercontent.com/$REPO/main/install.ps1 | iex" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) ARCH=arm64 ;;
  x86_64 | amd64) ARCH=x64 ;;
  *) die "Unsupported processor: $(uname -m)" ;;
esac
command -v curl >/dev/null || die "curl is needed."

if [ -n "${CROSSTALK_DOWNLOAD_BASE:-}" ]; then BASE="$CROSSTALK_DOWNLOAD_BASE"   # a mirror, or a test
elif [ "$VERSION" = "latest" ]; then BASE="https://github.com/$REPO/releases/latest/download"
else BASE="https://github.com/$REPO/releases/download/$VERSION"; fi
BIN="crosstalk-hub-$OS-$ARCH"

bold "Crosstalk: downloading the hub for $OS-$ARCH"
DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT
for f in "$BIN" "$SETUP" SHA256SUMS; do
  curl -fSL --retry 3 --progress-bar -o "$DIR/$f" "$BASE/$f" || die "Couldn't download $f from $BASE"
done

# Only what's listed in SHA256SUMS, and only if it matches.
( cd "$DIR"
  grep -E "  ($BIN|$SETUP)\$" SHA256SUMS > want || die "SHA256SUMS doesn't list $BIN"
  if command -v sha256sum >/dev/null; then sha256sum -c want >/dev/null; else shasum -a 256 -c want >/dev/null; fi
) || die "The download doesn't match its checksum. Nothing was installed; try again."
info "Checksums match ✓"

chmod +x "$DIR/$BIN" "$DIR/$SETUP"
# The platform installer finds the hub next to itself. On a pipe there's no terminal for its questions (sudo asks for
# your password), so it reads them from the terminal you ran this in.
# With no terminal at all (an automated run), it goes on without one.
if [ -t 0 ] || ! (exec < /dev/tty) 2>/dev/null; then "$DIR/$SETUP" "$@"; else "$DIR/$SETUP" "$@" < /dev/tty; fi
