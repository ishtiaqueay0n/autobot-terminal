#!/bin/bash
# Runs after the rpm's files are removed. electron-builder's default script (kept below, with the guard added)
# deletes the /usr/bin/autobot launcher every time, but when rpm upgrades or reinstalls a package it runs the OLD
# package's removal script AFTER the new package's install script, so the launcher the new install just created
# vanished. rpm passes the number of installed instances left in $1: 0 for a real uninstall, 1 or more otherwise.

if [ "${1:-0}" -gt 0 ] 2>/dev/null; then
    exit 0
fi

# Delete the link to the binary
# update-alternatives --remove <name> <path>: 'path' must be the registered alternative binary,
# not the generic symlink.
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove 'autobot' '/opt/Autobot Terminal/autobot'
else
    rm -f '/usr/bin/autobot'
fi

# The rpm does not own the directories it created, so the empty tree stays behind. Remove the empty directories
# under our own folder, and nothing that still holds a file.
find '/opt/Autobot Terminal' -depth -type d -empty -delete 2>/dev/null || true

APPARMOR_PROFILE_DEST='/etc/apparmor.d/autobot'

# Remove and unload apparmor profile (only present where AppArmor accepted the bundled one).
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi
