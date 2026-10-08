#!/usr/bin/env bash
# Runs the tests natively on Linux (a WSL distro or any Linux box), from a copy of the source in ~/autobot-dev.
#
#   scripts/test-linux-wsl.sh         unit and integration tests (real bash with the Autobot hook)
#   scripts/test-linux-wsl.sh e2e     also builds the app and runs the Playwright tests against it
#
# From Windows:  wsl -d rocky8 -u dev -e bash "/mnt/f/AI Terminal/scripts/test-linux-wsl.sh"
# Set AUTOBOT_SRC when the source is not in /mnt/f/AI Terminal. The e2e mode needs a display (WSLg) and
# the Electron runtime libraries (see docs/INSTALL-LINUX.md).
set -euo pipefail
SRC="${AUTOBOT_SRC:-/mnt/f/AI Terminal}"
. "$SRC/scripts/lib-linux.sh"
need_build_tools
private_node
sync_source "$SRC" "$DEV/app"
cd "$DEV/app"
echo "node $(node -v), npm $(npm -v), glibc $(glibc_version), python $("$PYTHON" --version 2>&1)"
npm ci --no-audit --no-fund 2>&1 | tail -3
ls node_modules/node-pty/build/Release/pty.node
npx vitest run 2>&1 | tail -15

if [ "${1:-}" = e2e ]; then
  [ -x node_modules/electron/dist/electron ] || node node_modules/electron/install.js
  [ -d resources/kb ] || npm run kb
  export DISPLAY="${DISPLAY:-:0}"
  npm run build 2>&1 | tail -2
  npx playwright test 2>&1 | tail -25
fi
