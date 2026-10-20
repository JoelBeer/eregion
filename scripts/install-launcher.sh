#!/usr/bin/env bash
# Adds Eregion to the desktop's app list. Inside WSL, WSLg puts it in the Windows Start menu too,
# with the anvil icon. Run: npm run install-launcher
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$apps"

cat > "$apps/eregion.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Eregion
Comment=Takes Linear tickets through an AI pipeline: plan, build, review, PR and watch CI
Exec=bash -lc 'cd "$repo" && npm start'
Icon=$repo/build/icon.png
Terminal=false
StartupWMClass=eregion
Categories=Development;
DESKTOP

echo "Added $apps/eregion.desktop"
if [ -n "${WSL_DISTRO_NAME:-}" ]; then
  echo "In WSL it appears in the Windows Start menu under ${WSL_DISTRO_NAME}. If it doesn't, run 'wsl --shutdown' in Windows and open Ubuntu again."
fi
