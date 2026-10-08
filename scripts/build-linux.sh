#!/usr/bin/env bash
# Builds the Linux packages (.rpm, .deb, .AppImage) into release/<version>/.
#
#   scripts/build-linux.sh
#
# Build on the OLDEST system you want to run on. node-pty is compiled here and keeps this machine's glibc
# floor: a build on RHEL 8 / Rocky 8 (glibc 2.28) runs on RHEL 8 and 9 and on Ubuntu 22.04 and 24.04, while a
# build on Ubuntu 24.04 (glibc 2.39) does not start on RHEL 8 or 9.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib-linux.sh

[ "$(uname -s)" = Linux ] || die "run this on Linux (on Windows use scripts/build-linux-wsl.ps1 or scripts\\build-windows-installer.cmd)"
[ "$(uname -m)" = x86_64 ] || die "only x86_64 packages are built for now"
need_node
need_build_tools

glibc="$(glibc_version)"
echo "== Autobot Terminal: Linux build =="
echo "node $(node -v), npm $(npm -v), glibc $glibc, python $("$PYTHON" --version 2>&1)"
if [ "$(printf '%s\n2.28\n' "$glibc" | sort -V | tail -1)" != "2.28" ]; then
  echo "warning: this machine has glibc $glibc. The packages will not start on RHEL 8 (glibc 2.28)." >&2
  echo "         Build on RHEL 8 / Rocky 8 / AlmaLinux 8 to support it." >&2
fi

echo "-- Installing dependencies (compiles node-pty) --"
npm ci --no-audit --no-fund
[ -f node_modules/node-pty/build/Release/pty.node ] || die "node-pty did not build (see the output above)"

# electron-builder builds the .rpm with a bundled Ruby (fpm) that puts its own OpenSSL 1.1 on LD_LIBRARY_PATH.
# On RHEL 8 (OpenSSL 1.1.1) that breaks the system rpmbuild ("symbol lookup error ... EVP_md2"), so rpmbuild
# is run through a shim with a clean library path. RHEL 9 and Ubuntu (OpenSSL 3) are unaffected.
shims="$(mktemp -d)"
trap 'rm -rf "$shims"' EXIT
if real_rpmbuild="$(command -v rpmbuild)"; then
  printf '#!/bin/sh\nunset LD_LIBRARY_PATH\nexec "%s" "$@"\n' "$real_rpmbuild" > "$shims/rpmbuild"
  chmod +x "$shims/rpmbuild"
  export PATH="$shims:$PATH"
else
  echo "warning: rpmbuild not found, the .rpm will not be built (RHEL: dnf install rpm-build · Ubuntu: apt install rpm)" >&2
fi

echo "-- Building packages --"
npm run dist:linux

version="$(node -p "require('./package.json').version")"
echo
echo "Done. Packages in release/$version:"
( cd "release/$version" && ls -1 ./*.rpm ./*.deb ./*.AppImage 2>/dev/null | while read -r f; do
    printf '  %s  %s\n' "$(du -h "$f" | cut -f1)" "${f#./}"
  done )
