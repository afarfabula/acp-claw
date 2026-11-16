#!/usr/bin/env bash
set -euo pipefail

source "$(dirname -- "$0")/common.sh"

service_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$service_dir"

for unit in server-chrome-xvfb server-chrome-vnc server-chrome-novnc server-chrome-browser; do
  install -m 644 "$TOOL_DIR/$unit.service" "$service_dir/$unit.service"
done

systemctl --user daemon-reload
systemctl --user enable server-chrome-xvfb.service \
  server-chrome-vnc.service \
  server-chrome-novnc.service \
  server-chrome-browser.service
systemctl --user restart server-chrome-xvfb.service \
  server-chrome-vnc.service \
  server-chrome-novnc.service \
  server-chrome-browser.service
