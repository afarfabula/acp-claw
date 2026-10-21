#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/enroot-env.sh"
cd "$OVERLEAF_DIR"

if [ -f "$OVERLEAF_RUN_DIR/overleaf.pid" ] &&
  kill -0 "$(cat "$OVERLEAF_RUN_DIR/overleaf.pid")" 2>/dev/null; then
  echo "stop Overleaf before upgrading: ./stop.sh" >&2
  exit 1
fi

"$OVERLEAF_DIR/install-runtime.sh"

enroot load \
  --name "mongo-8.0" \
  --force \
  "docker://docker.1panel.live/library/mongo:8.0"
enroot load \
  --name "redis-6.2" \
  --force \
  "docker://docker.1panel.live/library/redis:6.2"
enroot load \
  --name "overleaf-$OVERLEAF_VERSION" \
  --force \
  "docker://docker.1panel.live/sharelatex/sharelatex:$OVERLEAF_VERSION"

"$OVERLEAF_DIR/prepare-overleaf-rootfs.sh"
"$OVERLEAF_DIR/install-texlive-full.sh"
echo "images and TeX Live are ready; run ./start.sh"
