#!/bin/sh
# Builds Crosstalk Hub for Linux (a .deb and an AppImage) on a Linux machine, with a hub inside it:
#   native/hub-tray/scripts/build-linux.sh
# Needs Rust, bun and Tauri's Linux packages (docs/HUB-APP.md lists them). Written to match build-macos.sh; it hasn't
# run on Linux yet (scripts/check-linux.sh type-checks the app for Linux on a Mac).
set -e
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
ROOT="$(cd ../.. && pwd)"
case "$(uname -m)" in
  x86_64 | amd64) TARGET=linux-x64 ;;
  aarch64 | arm64) TARGET=linux-arm64 ;;
  *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac
VERSION=$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$ROOT/hub/package.json" | head -n 1)
HUB="$ROOT/hub/out/crosstalk-hub-$TARGET"
if [ ! -x "$HUB" ] || [ "$("$HUB" version 2>/dev/null)" != "$VERSION" ]; then
  (cd "$ROOT" && bun hub/scripts/build.ts "$TARGET")
fi
EXTRA="$(mktemp -d)"
printf '{"bundle":{"resources":{"%s":"hub/crosstalk-hub"}}}\n' "$HUB" >"$EXTRA/bundle.json"
# Ayatana's AppIndicator: the .deb then depends on libayatana-appindicator3-1, which current Debian and Ubuntu have
# (the older libappindicator3-1 is gone from them).
TAURI_LINUX_AYATANA_APPINDICATOR=1 ../node_modules/.bin/tauri build --bundles deb,appimage --config "$EXTRA/bundle.json"
rm -rf "$EXTRA"
ls -1 target/release/bundle/deb/*.deb target/release/bundle/appimage/*.AppImage
