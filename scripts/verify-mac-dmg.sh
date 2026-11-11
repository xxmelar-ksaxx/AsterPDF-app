#!/bin/bash
set -euo pipefail
dmg=${1:?Expected a release DMG path}
mount_dir=$(mktemp -d)
mounted=false
cleanup() {
  if [[ "$mounted" == true ]]; then
    hdiutil detach "$mount_dir" >/dev/null || return 1
  fi
  rmdir "$mount_dir"
}
trap cleanup EXIT
echo "Checking the app inside $dmg..."
hdiutil attach -readonly -nobrowse -mountpoint "$mount_dir" "$dmg" >/dev/null
mounted=true
app="$mount_dir/AsterPDF.app"
codesign --verify --deep --strict "$app"
xcrun stapler validate "$app"
spctl --assess --type execute --verbose=2 "$app"
