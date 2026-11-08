#!/bin/sh
# Builds "Crosstalk Hub.app" for this Mac with a hub inside it (for Install on a Mac that has none):
#   native/hub-tray/scripts/build-macos.sh
# The hub comes from hub/out (built first when it's missing or isn't this version). The app is signed ad hoc; the
# release step signs it with the Apple Development identity. Only the .app is made: Tauri's .dmg step scripts Finder,
# which fails on a headless Mac (native/scripts/package-macos.sh makes a .dmg with hdiutil instead).
set -e
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
ROOT="$(cd ../.. && pwd)"
case "$(uname -m)" in
  arm64) TARGET=darwin-arm64 ;;
  x86_64) TARGET=darwin-x64 ;;
  *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac
VERSION=$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$ROOT/hub/package.json" | head -n 1)
HUB="$ROOT/hub/out/crosstalk-hub-$TARGET"
if [ ! -x "$HUB" ] || [ "$("$HUB" version 2>/dev/null)" != "$VERSION" ]; then
  (cd "$ROOT" && bun hub/scripts/build.ts "$TARGET")
fi
# The hub goes in as a resource of this build only, so `cargo test` and plain `tauri build` don't need one.
EXTRA="$(mktemp -d)"
printf '{"bundle":{"resources":{"%s":"hub/crosstalk-hub"}}}\n' "$HUB" >"$EXTRA/bundle.json"
# The workspace's own CLI: `bunx tauri` can resolve to an unrelated npm package.
../node_modules/.bin/tauri build --bundles app --config "$EXTRA/bundle.json"
rm -rf "$EXTRA"
APP="target/release/bundle/macos/Crosstalk Hub.app"
codesign -v --strict "$APP" 2>/dev/null || codesign --force --deep --sign - "$APP"
codesign -v --strict "$APP"
[ -x "$APP/Contents/Resources/hub/crosstalk-hub" ] || { echo "The hub isn't inside $APP" >&2; exit 1; }
echo "Built $(pwd)/$APP (hub $VERSION inside)"
