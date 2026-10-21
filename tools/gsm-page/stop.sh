#!/usr/bin/env bash
set -euo pipefail

state_dir=${XDG_STATE_HOME:-$HOME/.local/state}/acp-claw
pid_file="$state_dir/gsm-page.pid"

if [ ! -f "$pid_file" ]; then
  echo "gsm page is not running"
  exit 0
fi

pid=$(cat "$pid_file")
kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
rm -f "$pid_file"
echo "gsm page stopped"
