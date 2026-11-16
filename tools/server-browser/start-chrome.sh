#!/usr/bin/env bash
set -euo pipefail

source "$(dirname -- "$0")/common.sh"

if [[ ! -x "$CHROME_BIN" ]]; then
  printf 'Missing Chrome executable: %s\n' "$CHROME_BIN" >&2
  exit 1
fi

mkdir -p "$PROFILE_DIR"
chmod 700 "$PROFILE_DIR"

exec "$CHROME_BIN" \
  --user-data-dir="$PROFILE_DIR" \
  --start-maximized \
  --window-position=0,0 \
  --window-size="${SCREEN_WIDTH},${SCREEN_HEIGHT}" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9223 \
  --password-store=basic \
  --disable-gpu \
  --disable-dev-shm-usage \
  --disable-session-crashed-bubble \
  --no-first-run \
  --no-default-browser-check \
  --noerrdialogs \
  about:blank
