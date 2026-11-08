#!/bin/sh
# Type-checks the whole hub app for Linux (x86_64) on a machine without GTK, such as a Mac: stand-in pkg-config files
# answer for the system libraries, which `cargo check` never links. That catches Rust errors in the Linux-only code
# (tray check, autostart entry, systemd); building and trying the app itself needs a Linux machine (docs/HUB-APP.md).
#   native/hub-tray/scripts/check-linux.sh
set -e
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
TARGET=x86_64-unknown-linux-gnu
rustup target list --installed | grep -qx "$TARGET" || { echo "Add the target first: rustup target add $TARGET" >&2; exit 1; }
command -v pkg-config >/dev/null || { echo "pkg-config is needed (brew install pkgconf)" >&2; exit 1; }
STUBS="$(mktemp -d)"
trap 'rm -rf "$STUBS"' EXIT
# What the GTK, WebKitGTK and D-Bus -sys crates ask pkg-config for (their package.metadata.system-deps).
for lib in glib-2.0 gobject-2.0 gio-2.0 gio-unix-2.0 gmodule-2.0 cairo cairo-gobject pango pangocairo gdk-pixbuf-2.0 atk \
  gdk-3.0 gdk-x11-3.0 gdk-wayland-3.0 gtk+-3.0 javascriptcoregtk-4.1 libsoup-3.0 webkit2gtk-4.1 dbus-1; do
  printf 'Name: %s\nDescription: stand-in for a type check\nVersion: 99.0\nLibs:\nCflags:\n' "$lib" >"$STUBS/$lib.pc"
done
PKG_CONFIG_ALLOW_CROSS=1 PKG_CONFIG_PATH="$STUBS" PKG_CONFIG_LIBDIR="$STUBS" CARGO_TARGET_DIR=target/linux-check \
  cargo check --workspace --all-targets --target "$TARGET"
echo "The hub app type-checks for Linux ($TARGET)."
