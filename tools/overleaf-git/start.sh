#!/usr/bin/env bash
set -euo pipefail

bridge_dir=$(cd "$(dirname "$0")" && pwd)
state_dir=/home_ext/quyanyi/overleaf-data/git-bridge
mkdir -p "$state_dir"

if [ -f "$state_dir/poller.pid" ] &&
  kill -0 "$(cat "$state_dir/poller.pid")" 2>/dev/null; then
  echo "Overleaf Git bridge already running: $(cat "$state_dir/poller.pid")"
  exit 0
fi

node "$bridge_dir/bridge.mjs" init
nohup setsid node "$bridge_dir/bridge.mjs" poll \
  >"$state_dir/bridge.log" 2>&1 </dev/null &
echo $! >"$state_dir/poller.pid"
echo "Overleaf Git bridge started: $(cat "$state_dir/poller.pid")"
