#!/usr/bin/env bash
set -euo pipefail

page_dir=$(cd "$(dirname "$0")" && pwd)
state_dir=${XDG_STATE_HOME:-$HOME/.local/state}/acp-claw
mkdir -p "$state_dir"

if [ -f "$state_dir/gsm-page.pid" ] &&
  kill -0 "$(cat "$state_dir/gsm-page.pid")" 2>/dev/null; then
  echo "gsm page is already running: $(cat "$state_dir/gsm-page.pid")"
  exit 0
fi

(
  cd "$page_dir"
  JSM_PORT=8820 JSM_PASSWORD=${JSM_PASSWORD:-JSMZKAL} \
    nohup setsid node server.mjs >"$state_dir/gsm-page.log" 2>&1 &
  echo $! >"$state_dir/gsm-page.pid"
)

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8820/ >/dev/null 2>&1; then
    echo "gsm page started on http://127.0.0.1:8820"
    exit 0
  fi
  sleep 0.2
done

echo "gsm page failed to become healthy; see $state_dir/gsm-page.log" >&2
exit 1
