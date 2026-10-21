#!/usr/bin/env bash
set -euo pipefail

state_dir=/home_ext/quyanyi/overleaf-data/git-bridge
pid_file="$state_dir/poller.pid"
if [ ! -f "$pid_file" ]; then
  echo "Overleaf Git bridge is not running"
  exit 0
fi
pid=$(cat "$pid_file")
kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
rm -f "$pid_file"
echo "Overleaf Git bridge stopped"
