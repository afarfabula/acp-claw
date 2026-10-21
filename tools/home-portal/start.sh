#!/usr/bin/env bash
set -euo pipefail

portal_dir=$(cd "$(dirname "$0")" && pwd)
state_dir=${XDG_STATE_HOME:-$HOME/.local/state}/acp-claw
mkdir -p "$state_dir"

if [ -f "$state_dir/home-portal.pid" ] &&
  kill -0 "$(cat "$state_dir/home-portal.pid")" 2>/dev/null; then
  echo "home portal is already running: $(cat "$state_dir/home-portal.pid")"
  exit 0
fi

(
  cd "$portal_dir"
  nohup setsid node service.mjs >"$state_dir/home-portal.log" 2>&1 &
  echo $! >"$state_dir/home-portal.pid"
)

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; then
    echo "home portal started on http://127.0.0.1:8080"
    exit 0
  fi
  sleep 0.2
done

echo "home portal failed to become healthy; see $state_dir/home-portal.log" >&2
exit 1
