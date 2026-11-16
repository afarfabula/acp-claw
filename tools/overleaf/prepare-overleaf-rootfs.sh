#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/enroot-env.sh"

rootfs="$ENROOT_DATA_PATH/overleaf-$OVERLEAF_VERSION"
if [ ! -d "$rootfs" ]; then
  echo "missing Overleaf rootfs: $rootfs" >&2
  exit 1
fi

nginx_conf="$rootfs/etc/nginx/sites-enabled/overleaf.conf"
clsi_nginx_conf="$rootfs/etc/nginx/sites-enabled/clsi-nginx.conf"
settings_conf="$rootfs/etc/overleaf/settings.js"
if [ ! -f "$nginx_conf" ]; then
  echo "missing nginx config: $nginx_conf" >&2
  exit 1
fi
if [ ! -f "$clsi_nginx_conf" ]; then
  echo "missing nginx config: $clsi_nginx_conf" >&2
  exit 1
fi
if [ ! -f "$settings_conf" ]; then
  echo "missing Overleaf settings: $settings_conf" >&2
  exit 1
fi

sed -i \
  -e 's/listen[[:space:]]\+80[[:space:]]\+default_server;/listen 127.0.0.1:51007 default_server;/g' \
  -e 's/listen[[:space:]]\+80;/listen 127.0.0.1:51007;/g' \
  -e 's/listen[[:space:]]\+51007;/listen 127.0.0.1:51007;/g' \
  -e 's/listen \[::\]:80 default_server;//g' \
  -e 's/127\.0\.0\.1:8080/127.0.0.1:51008/g' \
  "$nginx_conf"

sed -i \
  -e 's/listen[[:space:]]\+8080;/listen 127.0.0.1:51008;/g' \
  "$clsi_nginx_conf"

if grep -Eq 'listen (\[::\]:)?80([ ;]|$)' "$nginx_conf" ||
  grep -Eq 'listen[[:space:]]+51007;' "$nginx_conf" ||
  grep -Eq 'listen[[:space:]]+8080;' "$clsi_nginx_conf"; then
  echo "failed to move Overleaf nginx to port 51007" >&2
  exit 1
fi

# Web's default CLSI downloadHost is port 8080. Keep it aligned with the
# relocated CLSI nginx listener, otherwise PDF download returns the other
# service's 404 while the PDF preview remains healthy.
if ! grep -Fq 'CLSI_DOWNLOAD_HOST_OVERRIDE' "$settings_conf"; then
  cat >>"$settings_conf" <<'EOF'

// CLSI_DOWNLOAD_HOST_OVERRIDE
module.exports.apis.clsi = {
  ...(module.exports.apis.clsi || {}),
  downloadHost: 'http://127.0.0.1:51008',
}
EOF
fi

# Enroot bind-mounts the host /dev read-only at the file level. The base image
# syslog hook tries to replace /dev/log and aborts startup for non-root users.
chmod -x "$rootfs/etc/my_init.d/10_syslog-ng.init"

echo "Overleaf rootfs prepared on internal port 51007"
