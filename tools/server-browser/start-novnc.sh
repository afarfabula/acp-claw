#!/usr/bin/env bash
set -euo pipefail

source "$(dirname -- "$0")/common.sh"

if [[ ! -x "$WEBSOCKIFY_BIN" ]]; then
  printf 'Missing websockify: %s\n' "$WEBSOCKIFY_BIN" >&2
  exit 1
fi
if [[ ! -f "$NOVNC_WEB/vnc.html" ]]; then
  printf 'Missing noVNC web root: %s\n' "$NOVNC_WEB" >&2
  exit 1
fi

exec "$WEBSOCKIFY_BIN" \
  --web="$NOVNC_WEB" \
  --heartbeat=30 \
  --unix-target="$VNC_SOCKET" \
  "127.0.0.1:$NOVNC_PORT"
