#!/usr/bin/env bash
# Install Linux system dependencies required by Tauri 2 on Debian/Ubuntu.
# Use this once on a fresh machine before running `pnpm tauri:dev`.

set -euo pipefail

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This script targets Debian/Ubuntu (apt-get). On Fedora/Arch use the equivalent commands." >&2
  exit 1
fi

PACKAGES=(
  libwebkit2gtk-4.1-dev
  libgtk-3-dev
  libayatana-appindicator3-dev
  librsvg2-dev
  libxdo-dev
  libssl-dev
  libglib2.0-dev
  libsoup-3.0-dev
  libjavascriptcoregtk-4.1-dev
  pkg-config
  build-essential
  curl
  wget
  file
  patchelf
)

echo "==> Updating apt index"
sudo apt-get update

echo "==> Installing Tauri 2 system dependencies (${#PACKAGES[@]} packages)"
sudo apt-get install -y "${PACKAGES[@]}"

echo "==> Done. Now run: pnpm install && pnpm tauri:dev"
