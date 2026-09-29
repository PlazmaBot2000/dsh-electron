#!/usr/bin/env bash
#
# Remove what install.sh created.
#
# Deliberately additive-only: the log under ~/.config/dsh-electron is left in
# place, because it is the only record of what went wrong in past runs. The
# shell keeps no other state.

set -euo pipefail

BIN_DIR="${DSH_ELECTRON_BIN_DIR:-$HOME/.local/bin}"
APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"

say() { printf '  %s\n' "$*"; }

echo "Removing the DeepSeek Harness desktop shell"

rm -f "$BIN_DIR/dsh-electron" && say "removed $BIN_DIR/dsh-electron"
rm -f "$APPS_DIR/dsh-electron.desktop" && say "removed $APPS_DIR/dsh-electron.desktop"
for size in 48 64 128 256 512; do
  rm -f "$ICONS_DIR/${size}x${size}/apps/dsh-electron.png"
done
say "removed icons"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
fi

echo
echo "Done. The log was kept at ~/.config/dsh-electron"
echo "(remove that directory by hand if you also want to discard it)."