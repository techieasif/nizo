#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="$ROOT_DIR/dist"
PROFILE_DIR="$ROOT_DIR/.chrome-nizo-profile"

find_chrome() {
  local candidates=(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
    "google-chrome"
    "google-chrome-stable"
    "chromium"
    "chromium-browser"
  )

  for candidate in "${candidates[@]}"; do
    if [[ "$candidate" == /* ]]; then
      if [ -x "$candidate" ]; then
        echo "$candidate"
        return 0
      fi
    else
      if command -v "$candidate" >/dev/null 2>&1; then
        echo "$candidate"
        return 0
      fi
    fi
  done

  return 1
}

"$ROOT_DIR/build.sh"

if [ ! -d "$DIST_DIR" ]; then
  echo "dist directory not found. Build likely failed."
  exit 1
fi

CHROME_BIN="$(find_chrome || true)"
if [ -z "$CHROME_BIN" ]; then
  echo "Could not find a Chrome/Chromium binary."
  echo "Open chrome://extensions and load: $DIST_DIR"
  exit 1
fi

mkdir -p "$PROFILE_DIR"

echo "Launching browser with Nizo extension..."
"$CHROME_BIN" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-extensions-except="$DIST_DIR" \
  --load-extension="$DIST_DIR" \
  "https://sentry.io/organizations/" >/dev/null 2>&1 &

echo "Browser started."
echo "Open a Sentry issue page and click Nizo in the extensions toolbar."
