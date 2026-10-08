#!/usr/bin/env bash
# One-time setup of a RHEL 8-family machine (RHEL 8/9, Rocky, AlmaLinux) for building the Linux packages.
# Run as root:  sudo scripts/setup-rhel-build-host.sh [build-user]
#
# Installs the compilers node-pty needs and rpm-build, and creates an unprivileged user (default: dev) to
# build with. Node itself is downloaded per user by scripts/build-linux.sh's helpers, no root needed.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "error: run as root (sudo $0)" >&2; exit 1; }
user="${1:-dev}"
. /etc/os-release
major="${VERSION_ID%%.*}"

pkgs=(gcc-c++ make git xz unzip tar which findutils rpm-build binutils)
case "$major" in
  8)
    # Stock gcc 8 cannot compile against Node 22+ headers (C++20); node-gyp also needs Python 3.8+.
    pkgs+=(gcc-toolset-13-gcc-c++ python3.11)
    ;;
  9) pkgs+=(python3) ;;
  *) echo "warning: untested on ${PRETTY_NAME:-this system}; continuing" >&2; pkgs+=(python3) ;;
esac
echo "Installing: ${pkgs[*]}"
dnf -y install "${pkgs[@]}"

id "$user" >/dev/null 2>&1 || useradd -m "$user"
echo "Done. Build as '$user':  su - $user -c 'cd <repo> && scripts/build-linux.sh'"
echo "(glibc here is $(getconf GNU_LIBC_VERSION | cut -d' ' -f2); packages built on this machine need at least that.)"
