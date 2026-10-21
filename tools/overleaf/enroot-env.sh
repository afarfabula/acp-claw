#!/usr/bin/env bash
set -euo pipefail

overleaf_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

set -a
# shellcheck disable=SC1091
source "$overleaf_dir/.env"
set +a

export ENROOT_LIBRARY_PATH="$ENROOT_PREFIX/usr/lib/enroot"
export ENROOT_SYSCONF_PATH="$ENROOT_PREFIX/etc/enroot"
export ENROOT_RUNTIME_PATH="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/enroot-overleaf"
export ENROOT_CONFIG_PATH="${XDG_CONFIG_HOME:-$HOME/.config}/enroot"
export ENROOT_CACHE_PATH="$OVERLEAF_DATA_ROOT/enroot-cache"
export ENROOT_DATA_PATH="$OVERLEAF_DATA_ROOT/enroot-data"
export ENROOT_TEMP_PATH="$OVERLEAF_DATA_ROOT/tmp"
export ENROOT_ROOTFS_WRITABLE=yes
export ENROOT_MAX_PROCESSORS=8
export ENROOT_MAX_CONNECTIONS=8

export OVERLEAF_LOG_DIR="$OVERLEAF_DATA_ROOT/logs"
export OVERLEAF_RUN_DIR="$OVERLEAF_DATA_ROOT/run"
export OVERLEAF_DIR="$overleaf_dir"
export OVERLEAF_CONFIG_DIR="$overleaf_dir/configs"
export OVERLEAF_TMP_DIR="$OVERLEAF_DATA_ROOT/tmp"
export PATH="$overleaf_dir/runtime:$ENROOT_DEPS_PATH/bin:$ENROOT_PREFIX/usr/bin:$PATH"

mkdir -p \
  "$ENROOT_RUNTIME_PATH" \
  "$ENROOT_CONFIG_PATH" \
  "$ENROOT_CACHE_PATH" \
  "$ENROOT_DATA_PATH" \
  "$ENROOT_TEMP_PATH" \
  "$OVERLEAF_LOG_DIR" \
  "$OVERLEAF_RUN_DIR" \
  "$OVERLEAF_DATA_ROOT/sharelatex" \
  "$OVERLEAF_DATA_ROOT/mongo" \
  "$OVERLEAF_DATA_ROOT/redis"

if [ ! -f "$OVERLEAF_DATA_ROOT/hosts" ]; then
  printf '%s\n' \
    '127.0.0.1 localhost dockerhost' \
    '::1 localhost' \
    >"$OVERLEAF_DATA_ROOT/hosts"
fi
