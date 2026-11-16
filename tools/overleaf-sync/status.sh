#!/usr/bin/env bash
set -euo pipefail

sync_dir=$(cd "$(dirname "$0")" && pwd)
state_dir=/home_ext/quyanyi/overleaf-data/overleaf-sync
if [ -f "$state_dir/poller.pid" ] &&
  kill -0 "$(cat "$state_dir/poller.pid")" 2>/dev/null; then
  echo "sync running pid=$(cat "$state_dir/poller.pid")"
else
  echo "sync stopped"
fi
node "$sync_dir/sync.mjs" status
