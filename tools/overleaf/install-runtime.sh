#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/enroot-env.sh"

if [ ! -x "$ENROOT_PREFIX/usr/bin/enroot" ]; then
  tmp_dir=$(mktemp -d)
  trap 'rm -rf "$tmp_dir"' EXIT
  package="$tmp_dir/enroot.deb"
  curl -fL \
    "https://github.com/NVIDIA/enroot/releases/download/v${ENROOT_VERSION}/enroot_${ENROOT_VERSION}-1_amd64.deb" \
    -o "$package"
  mkdir -p "$ENROOT_PREFIX"
  dpkg-deb -x "$package" "$ENROOT_PREFIX"
fi

if [ ! -x "$ENROOT_DEPS_PATH/bin/jq" ] ||
  [ ! -x "$ENROOT_DEPS_PATH/bin/parallel" ]; then
  conda create -y -p "$ENROOT_DEPS_PATH" -c conda-forge jq parallel
fi

echo "runtime ready"
enroot version
