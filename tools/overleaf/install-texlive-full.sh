#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/enroot-env.sh"

rootfs="$ENROOT_DATA_PATH/overleaf-$OVERLEAF_VERSION"
if [ ! -d "$rootfs" ]; then
  echo "missing Overleaf rootfs: $rootfs" >&2
  exit 1
fi

marker="$rootfs/etc/overleaf-scheme-full"
if [ -f "$marker" ]; then
  echo "TeX Live scheme-full is already installed"
  exit 0
fi

if [ -f "$OVERLEAF_RUN_DIR/overleaf.pid" ] &&
  kill -0 "$(cat "$OVERLEAF_RUN_DIR/overleaf.pid")" 2>/dev/null; then
  echo "stop Overleaf before installing TeX Live packages" >&2
  echo "run: ./stop.sh" >&2
  exit 1
fi

enroot start --root --rw \
  --pid \
  --conf "$OVERLEAF_CONFIG_DIR/texlive-full.conf" \
  "overleaf-$OVERLEAF_VERSION"

echo "TeX Live scheme-full installed"
