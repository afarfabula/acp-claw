#!/usr/bin/env bash
set -euo pipefail

source "$(dirname -- "$0")/common.sh"

exec /usr/bin/Xvfb "$DISPLAY" \
  -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH}" \
  -dpi 96 \
  -nolisten tcp \
  -noreset
