#!/usr/bin/env bash
set -euo pipefail

source "$(dirname -- "$0")/common.sh"

if [[ ! -x "$X11VNC_BIN" ]]; then
  printf 'Missing x11vnc: %s\n' "$X11VNC_BIN" >&2
  exit 1
fi

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
rm -f "$VNC_SOCKET"
umask 077

exec "$X11VNC_BIN" \
  -display "$DISPLAY" \
  -unixsock "$VNC_SOCKET" \
  -rfbport 0 \
  -nopw \
  -forever \
  -shared \
  -noxdamage \
  -wait 20 \
  -defer 20
