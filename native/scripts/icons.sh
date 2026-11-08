#!/usr/bin/env bash
# Regenerate every platform's app icons from web/public sources.
#   - iOS/Android/Windows tiles: full-bleed square (platforms apply their own mask)
#   - macOS/desktop: rounded macOS-style icon with margins
#   - iOS icons flattened to RGB (App Store rejects alpha)
# Run after `tauri ios init` / `tauri android init` so their asset folders exist.
set -euo pipefail
cd "$(dirname "$0")/.."
TAURI=./node_modules/.bin/tauri
python3 ../web/scripts/make-icons.py >/dev/null
"$TAURI" icon ../web/public/icon-square-1024.png >/dev/null 2>&1
TMP="$(mktemp -d)"
"$TAURI" icon ../web/public/icon-macos-1024.png -o "$TMP" >/dev/null 2>&1
for f in icon.icns icon.ico 32x32.png 64x64.png 128x128.png 128x128@2x.png icon.png; do cp "$TMP/$f" "src-tauri/icons/$f"; done
APPICON=src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset
if [ -d "$APPICON" ]; then
  python3 - "$APPICON" <<'EOF'
import glob, sys
from PIL import Image
for f in glob.glob(sys.argv[1] + "/*.png"):
    im = Image.open(f)
    if im.mode != "RGB":
        bg = Image.new("RGB", im.size, (91, 140, 255))
        bg.paste(im, mask=im.split()[-1] if im.mode == "RGBA" else None)
        bg.save(f)
EOF
fi
echo "icons updated"
