#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but not found in PATH."
  exit 1
fi

if [ ! -d "$ROOT_DIR/node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

echo "Building extension..."
npm run build

if [ ! -f "$ROOT_DIR/dist/manifest.json" ]; then
  echo "Build completed but dist/manifest.json is missing."
  exit 1
fi

echo ""
echo "Build successful."
echo "Load this folder as unpacked extension:"
echo "  $ROOT_DIR/dist"
