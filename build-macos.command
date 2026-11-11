#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Run this script on a Mac. It builds Apple Silicon and Intel installers."
  exit 1
fi
command -v node >/dev/null || { echo "Node.js 20 or newer is required."; exit 1; }
command -v npm >/dev/null || { echo "npm is required."; exit 1; }
if [[ -z "${APPLE_ID:-}" && -z "${APPLE_API_KEY:-}" ]]; then
  export APPLE_KEYCHAIN_PROFILE="${APPLE_KEYCHAIN_PROFILE:-AsterPDF-notary}"
  notary_args=(--keychain-profile "$APPLE_KEYCHAIN_PROFILE")
  if [[ -n "${APPLE_KEYCHAIN:-}" ]]; then
    notary_args+=(--keychain "$APPLE_KEYCHAIN")
  fi
  echo "Checking Apple notarization access for $APPLE_KEYCHAIN_PROFILE..."
  xcrun notarytool history "${notary_args[@]}" >/dev/null || {
    echo "Could not access Apple notarization with this Keychain profile. Build stopped." >&2
    exit 1
  }
fi
npm ci
npm run build:mac -- --config.forceCodeSigning=true --config.mac.notarize=true
version=$(node -p 'require("./package.json").version')
for arch in arm64 x64; do
  bash scripts/verify-mac-dmg.sh "release/AsterPDF-${version}-macOS-${arch}.dmg"
done
npm run checksum:mac
echo "Apple Silicon (arm64) and Intel (x64) DMGs, ZIPs, SHA-256 checksums and shared latest-mac.yml are in $(pwd)/release"
echo "Upload these release files together. In-app installation requires signed macOS builds."
