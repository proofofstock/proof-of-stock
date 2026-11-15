#!/usr/bin/env bash
# scripts/og/render.sh: re-render the checked-in link-preview image (apps/stocks-web/og.png, 1200×630) and the raster
# logo (apps/stocks-web/logo.png, 512×512) from their HTML sources here, with a headless Chromium (Chrome or Edge).
# The site serves the PNGs as they are in the repository; nothing renders on the server.
#
#   CHROME=/path/to/chrome bash scripts/og/render.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=$(cd "$here/../../apps/stocks-web" && pwd)
chrome=${CHROME:-$(command -v chromium || command -v google-chrome || command -v chrome || echo chrome)}
shot () { "$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --virtual-time-budget=5000 \
  --window-size="$2" --screenshot="$out/$3" "file://$here/$1" >/dev/null 2>&1; echo "wrote apps/stocks-web/$3"; }
shot og.html 1200,630 og.png
shot logo.html 512,512 logo.png
