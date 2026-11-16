#!/usr/bin/env bash
set -euo pipefail

source_dir=$(cd "$(dirname "$0")" && pwd)
cloudflared_dir=${CLOUDFLARED_DIR:-$HOME/.cloudflared}
service_dir=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
cloudflared_bin=${CLOUDFLARED_BIN:-$HOME/bin/cloudflared}
config_source=${CLOUDFLARED_CONFIG_SOURCE:-$source_dir/config.yml}

if [ ! -f "$config_source" ]; then
  echo "missing $config_source; copy config.example.yml and fill in local values" >&2
  exit 1
fi

tunnel_id=${CLOUDFLARED_TUNNEL_ID:-$(awk '$1 == "tunnel:" { print $2; exit }' "$config_source")}
if [ -z "$tunnel_id" ]; then
  echo "missing tunnel id in $config_source" >&2
  exit 1
fi

hostnames=(
  $(awk '$1 == "-" && $2 == "hostname:" { print $3 }' "$config_source")
)
if [ "${#hostnames[@]}" -eq 0 ]; then
  echo "no ingress hostnames found in $config_source" >&2
  exit 1
fi

mkdir -p "$cloudflared_dir" "$service_dir"
backup_dir="$cloudflared_dir/backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
find "$cloudflared_dir" -maxdepth 1 -type f -exec cp -a -t "$backup_dir" {} +
echo "backup: $backup_dir"

for hostname in "${hostnames[@]}"; do
  "$cloudflared_bin" tunnel route dns --overwrite-dns "$tunnel_id" "$hostname"
done

install -m 600 "$config_source" "$cloudflared_dir/config.yml"
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
    "cloudflared tunnel.*--config ${cloudflared_dir}/(code-ide|config)\\.yml run" ||
    true
)

for _ in $(seq 1 50); do
  if ! pgrep -f \
    "cloudflared tunnel.*--config ${cloudflared_dir}/(code-ide|config)\\.yml run" \
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
