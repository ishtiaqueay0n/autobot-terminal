#!/usr/bin/env bash
# Builds the Linux packages inside a WSL distro and copies them to release/<version>/ in the Windows folder.
#
#   wsl -d rocky8 -u dev -e bash "/mnt/f/AI Terminal/scripts/build-linux-wsl.sh"
#
# Use a RHEL 8-compatible distro (Rocky 8, AlmaLinux 8): see scripts/setup-rhel-wsl.ps1 and docs/INSTALL-LINUX.md.
set -euo pipefail
SRC="${AUTOBOT_SRC:-/mnt/f/AI Terminal}"
. "$SRC/scripts/lib-linux.sh"
need_build_tools
private_node
sync_source "$SRC" "$DEV/app"
cd "$DEV/app"
bash scripts/build-linux.sh

version="$(node -p "require('./package.json').version")"
mkdir -p "$SRC/release/$version"
cp -v release/"$version"/*.rpm release/"$version"/*.deb release/"$version"/*.AppImage "$SRC/release/$version/"
