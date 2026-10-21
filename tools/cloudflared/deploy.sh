#!/usr/bin/env bash
set -euo pipefail

source_dir=$(cd "$(dirname "$0")" && pwd)
cloudflared_dir=/home/quyanyi/.cloudflared
service_dir=/home/quyanyi/.config/systemd/user
cloudflared_bin=/home/quyanyi/bin/cloudflared
tunnel_id=4f3d2630-c3c3-40d0-8587-229e8840132d
hostnames=(
  home.afarfabula.org
  code.afarfabula.org
  3090gpu.afarfabula.org
  overleaf.afarfabula.org
  resume.afarfabula.org
)

mkdir -p "$cloudflared_dir" "$service_dir"
backup_dir="$cloudflared_dir/backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
find "$cloudflared_dir" -maxdepth 1 -type f -exec cp -a -t "$backup_dir" {} +
echo "backup: $backup_dir"

for hostname in "${hostnames[@]}"; do
  "$cloudflared_bin" tunnel route dns --overwrite-dns "$tunnel_id" "$hostname"
done

install -m 600 "$source_dir/config.yml" "$cloudflared_dir/config.yml"
install -m 644 "$source_dir/cloudflared.service" \
  "$service_dir/cloudflared.service"

systemd_available=yes
if ! systemctl --user show-environment >/dev/null 2>&1; then
  systemd_available=no
  echo "user systemd bus unavailable; using a nohup-managed tunnel"
fi

if [ "$systemd_available" = yes ]; then
  systemctl --user stop cloudflared 2>/dev/null || true
fi

while read -r pid; do
  [ -n "$pid" ] || continue
  kill -TERM "$pid" 2>/dev/null || true
done < <(
  pgrep -f \
    '/home/quyanyi/bin/cloudflared tunnel --config /home/quyanyi/.cloudflared/(code-ide|config)\.yml run' ||
    true
)

for _ in $(seq 1 50); do
  if ! pgrep -f \
    '/home/quyanyi/bin/cloudflared tunnel --config /home/quyanyi/.cloudflared/(code-ide|config)\.yml run' \
    >/dev/null; then
    break
  fi
  sleep 0.2
done

if [ "$systemd_available" = yes ]; then
  systemctl --user daemon-reload
  systemctl --user enable cloudflared
  systemctl --user restart cloudflared

  for _ in $(seq 1 50); do
    if systemctl --user is-active --quiet cloudflared; then
      echo "cloudflared started with systemd"
      exit 0
    fi
    sleep 0.2
  done

  systemctl --user status cloudflared --no-pager >&2 || true
  exit 1
fi

nohup setsid "$cloudflared_bin" tunnel \
  --config "$cloudflared_dir/config.yml" \
  run "$tunnel_id" \
  >"$cloudflared_dir/cloudflared.log" 2>&1 </dev/null &
echo $! >"$cloudflared_dir/cloudflared.pid"

for _ in $(seq 1 50); do
  if kill -0 "$(cat "$cloudflared_dir/cloudflared.pid")" 2>/dev/null &&
    grep -q 'Registered tunnel connection' "$cloudflared_dir/cloudflared.log"; then
    echo "cloudflared started with nohup"
    exit 0
  fi
  sleep 0.2
done

tail -n 100 "$cloudflared_dir/cloudflared.log" >&2 || true
exit 1
