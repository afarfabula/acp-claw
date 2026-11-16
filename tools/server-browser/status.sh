#!/usr/bin/env bash
set -euo pipefail

systemctl --user status \
  server-chrome-xvfb.service \
  server-chrome-vnc.service \
  server-chrome-novnc.service \
  server-chrome-browser.service \
  --no-pager
