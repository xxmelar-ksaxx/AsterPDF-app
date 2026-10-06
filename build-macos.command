#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "Run this script on an Apple Silicon Mac."
  exit 1
fi
command -v node >/dev/null || { echo "Node.js 20 or newer is required."; exit 1; }
command -v npm >/dev/null || { echo "npm is required."; exit 1; }
npm ci
if [[ -n "${APPLE_ID:-}" || -n "${APPLE_API_KEY:-}" || -n "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then
  npm run build:mac -- --config.mac.notarize=true
else
  npm run build:mac -- --config.mac.notarize=false
  echo "Unsigned local build. Set Apple signing and notarization credentials for a public release."
fi
npm run checksum:mac
echo "macOS DMG, ZIP, and SHA-256 checksums are in $(pwd)/release"
