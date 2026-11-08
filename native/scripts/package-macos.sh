#!/bin/sh
# Builds the macOS app and a .dmg without needing a logged-in Finder session (Tauri's own .dmg step scripts Finder,
# which fails on a headless Mac), and checks the ad-hoc signature is intact.
set -e
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
./node_modules/.bin/tauri build --bundles app
BUNDLE=src-tauri/target/release/bundle
APP="$BUNDLE/macos/Crosstalk.app"
codesign -v --strict "$APP" || codesign --force --deep --sign - "$APP"
codesign -v --strict "$APP"
VERSION=$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' src-tauri/tauri.conf.json | head -n 1)
mkdir -p "$BUNDLE/dmg"
DMG="$BUNDLE/dmg/Crosstalk_${VERSION}_$(uname -m).dmg"
rm -f "$DMG"
hdiutil create -volname Crosstalk -srcfolder "$APP" -ov -format UDZO "$DMG" >/dev/null
hdiutil verify "$DMG" >/dev/null
echo "Built $APP and $DMG"
