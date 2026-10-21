#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/enroot-env.sh"

for name in overleaf redis mongo; do
  pid_file="$OVERLEAF_RUN_DIR/$name.pid"
  [ -f "$pid_file" ] || continue
  pid=$(cat "$pid_file")
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 60); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
  echo "stopped $name"
done
