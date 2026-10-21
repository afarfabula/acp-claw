#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/enroot-env.sh"

for name in mongo redis overleaf; do
  pid_file="$OVERLEAF_RUN_DIR/$name.pid"
  if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    printf '%-10s running pid=%s\n' "$name" "$(cat "$pid_file")"
  else
    printf '%-10s stopped\n' "$name"
  fi
done

for port in 27017 6379 "$OVERLEAF_PORT"; do
  if ss -ltn "sport = :$port" | grep -q LISTEN; then
    echo "port $port listening"
  else
    echo "port $port closed"
  fi
done
