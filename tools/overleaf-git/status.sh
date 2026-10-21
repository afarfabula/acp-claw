#!/usr/bin/env bash
set -euo pipefail

bridge_dir=$(cd "$(dirname "$0")" && pwd)
state_dir=/home_ext/quyanyi/overleaf-data/git-bridge
if [ -f "$state_dir/poller.pid" ] &&
  kill -0 "$(cat "$state_dir/poller.pid")" 2>/dev/null; then
  echo "poller running pid=$(cat "$state_dir/poller.pid")"
else
  echo "poller stopped"
fi
node "$bridge_dir/bridge.mjs" status
