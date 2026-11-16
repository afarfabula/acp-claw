#!/usr/bin/env bash
set -euo pipefail

sync_dir=$(cd "$(dirname "$0")" && pwd)
state_dir=/home_ext/quyanyi/overleaf-data/overleaf-sync
mkdir -p "$state_dir"

if [ -f "$state_dir/poller.pid" ] &&
  kill -0 "$(cat "$state_dir/poller.pid")" 2>/dev/null; then
  echo "Overleaf sync already running: $(cat "$state_dir/poller.pid")"
  exit 0
fi

nohup setsid node "$sync_dir/sync.mjs" run \
  >"$state_dir/sync.log" 2>&1 </dev/null &
echo $! >"$state_dir/poller.pid"
echo "Overleaf sync started: $(cat "$state_dir/poller.pid")"
