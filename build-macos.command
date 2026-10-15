#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Run this script on a Mac. It builds Apple Silicon and Intel installers."
  exit 1
fi
command -v node >/dev/null || { echo "Node.js 20 or newer is required."; exit 1; }
command -v npm >/dev/null || { echo "npm is required."; exit 1; }
npm ci
if [[ -n "${APPLE_ID:-}" || -n "${APPLE_API_KEY:-}" || -n "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then
  npm run build:mac -- --config.mac.notarize=true
else
  npm run build:mac -- --config.mac.notarize=false
  echo "Notarization was skipped. An installed signing identity may still have been used."
  echo "Use Developer ID Application signing and notarization credentials for a public release."
fi
npm run checksum:mac
echo "Apple Silicon (arm64) and Intel (x64) DMGs, ZIPs, SHA-256 checksums and shared latest-mac.yml are in $(pwd)/release"
echo "Upload these release files together. In-app installation requires signed macOS builds."
