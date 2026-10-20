#!/usr/bin/env bash
# Adds Eregion to the desktop's app list, with the anvil icon. Run: npm run install-launcher
#
# Inside WSL the entry goes in /usr/local/share (so it asks for your password): WSLg only reads app
# entries from the system folders, and it's the entry named after the window's app id (eregion) that
# gives the window its icon in the Windows taskbar and puts Eregion in the Start menu.
# Elsewhere it goes in your own ~/.local/share.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -n "${WSL_DISTRO_NAME:-}" ]; then
  share=/usr/local/share
  run() { sudo "$@"; }
  echo "Installing into $share, which needs sudo."
else
  share="${XDG_DATA_HOME:-$HOME/.local/share}"
  run() { "$@"; }
fi

for size in 16 32 48 64 128 256 512; do
  run install -D -m 644 "$repo/build/icons/${size}x${size}.png" "$share/icons/hicolor/${size}x${size}/apps/eregion.png"
done

entry="$(mktemp)"
cat > "$entry" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Eregion
Comment=Takes Linear tickets through an AI pipeline: plan, build, review, PR and watch CI
Exec=bash -lc 'cd "$repo" && npm start'
Icon=$share/icons/hicolor/256x256/apps/eregion.png
Terminal=false
StartupWMClass=eregion
Categories=Development;
DESKTOP
run install -D -m 644 "$entry" "$share/applications/eregion.desktop"
rm -f "$entry"
echo "Added $share/applications/eregion.desktop"

if [ -n "${WSL_DISTRO_NAME:-}" ]; then
  # An entry from an earlier install, which WSLg never read.
  rm -f "${XDG_DATA_HOME:-$HOME/.local/share}/applications/eregion.desktop"
  echo "Eregion is in the Windows Start menu under ${WSL_DISTRO_NAME}, and its taskbar icon is the anvil."
  echo "If either doesn't show, close Eregion, run 'wsl --shutdown' in Windows and open it again."
fi
