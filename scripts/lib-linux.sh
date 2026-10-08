#!/usr/bin/env bash
# Helpers shared by build-linux.sh and test-linux-wsl.sh (source this file).

die() { echo "error: $*" >&2; exit 1; }

# "2.28" for glibc 2.28.
glibc_version() { getconf GNU_LIBC_VERSION | cut -d' ' -f2; }

# node-gyp needs Python 3.8 or newer; RHEL 8's default python3 is 3.6, so look for a newer one.
pick_python() {
  local p
  for p in python3 python3.13 python3.12 python3.11 python3.10 python3.9 python3.8; do
    if command -v "$p" >/dev/null 2>&1 && "$p" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' 2>/dev/null; then
      command -v "$p"
      return 0
    fi
  done
  return 1
}

# Node 22+ headers are built as C++20; RHEL 8's stock gcc 8 does not know -std=gnu++20. Turns on a newer
# gcc-toolset (RHEL 8 ships 12 to 14 beside the system compiler) when the default one is too old.
use_modern_gcc() {
  local t
  echo 'int main() { return 0; }' | g++ -std=gnu++20 -x c++ -fsyntax-only - >/dev/null 2>&1 && return 0
  for t in 14 13 12; do
    if [ -f "/opt/rh/gcc-toolset-$t/enable" ]; then
      # shellcheck disable=SC1090
      . "/opt/rh/gcc-toolset-$t/enable"
      echo 'int main() { return 0; }' | g++ -std=gnu++20 -x c++ -fsyntax-only - >/dev/null 2>&1 && return 0
    fi
  done
  die "g++ $(g++ -dumpversion) is too old for Node's C++20 headers (RHEL 8: dnf install gcc-toolset-13-gcc-c++)"
}

# Checks the tools node-pty's native build needs and exports PYTHON for node-gyp.
need_build_tools() {
  local missing=() t
  for t in make g++ git; do command -v "$t" >/dev/null 2>&1 || missing+=("$t"); done
  [ ${#missing[@]} -eq 0 ] || die "missing: ${missing[*]} (Ubuntu: apt install build-essential git · RHEL: dnf install gcc-c++ make git)"
  use_modern_gcc
  PYTHON="$(pick_python)" || die "Python 3.8 or newer is needed for node-gyp (RHEL 8: dnf install python3.11)"
  export PYTHON
}

# Node 22 or newer (the project is built and tested on 24).
need_node() {
  command -v node >/dev/null 2>&1 || die "Node.js is not installed. Get Node 24 from https://nodejs.org"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 22 ] || die "Node $(node -v) is too old; use Node 22 or newer (24 recommended)"
}

# Private Node in ~/autobot-dev/node (no root needed), downloaded once and verified against nodejs.org's checksums.
NODE_VER="${AUTOBOT_NODE_VER:-v24.19.0}"
DEV="${AUTOBOT_DEV:-$HOME/autobot-dev}"
private_node() {
  mkdir -p "$DEV"
  if [ ! -x "$DEV/node/bin/node" ]; then
    command -v xz >/dev/null 2>&1 || die "xz is needed to unpack Node (RHEL: dnf install xz · Ubuntu: apt install xz-utils)"
    local tar="node-$NODE_VER-linux-x64.tar.xz" want got
    curl -fsSL "https://nodejs.org/dist/$NODE_VER/$tar" -o "$DEV/$tar"
    want="$(curl -fsSL "https://nodejs.org/dist/$NODE_VER/SHASUMS256.txt" | grep " $tar\$" | cut -d' ' -f1)"
    got="$(sha256sum "$DEV/$tar" | cut -d' ' -f1)"
    [ -n "$want" ] && [ "$want" = "$got" ] || die "Node download did not match its published checksum"
    mkdir -p "$DEV/node" && tar -xJf "$DEV/$tar" -C "$DEV/node" --strip-components=1 && rm "$DEV/$tar"
  fi
  export PATH="$DEV/node/bin:$PATH"
}

# Copies the working tree (without dependencies, build output or git data) to a fresh folder on the Linux
# filesystem: node_modules from Windows cannot be reused, and building on /mnt/<drive> is very slow.
sync_source() {
  local src="$1" dest="$2"
  rm -rf "$dest" && mkdir -p "$dest"
  tar -C "$src" --exclude=./node_modules --exclude=./out --exclude=./release --exclude=./.git \
      --exclude=./test-results --exclude=./playwright-report --exclude=./.cache -cf - . | tar -C "$dest" -xf -
}
