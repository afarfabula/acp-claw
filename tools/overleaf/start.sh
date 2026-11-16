#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/enroot-env.sh"
cd "$OVERLEAF_DIR"

port_open() {
  timeout 1 bash -c "</dev/tcp/127.0.0.1/$1" 2>/dev/null
}

running() {
  local pid_file="$OVERLEAF_RUN_DIR/$1.pid"
  [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null
}

container_pid() {
  enroot list -f | awk -v name="$1" '$1 == name { print $2; exit }'
}

start_component() {
  local name=$1
  local image=$2
  local conf=$3
  local pid_file="$OVERLEAF_RUN_DIR/$name.pid"

  if running "$name"; then
    echo "$name is already running"
    return
  fi

  nohup setsid enroot start \
    --root \
    --rw \
    --pid \
    --conf "$conf" \
    "$image" \
    >"$OVERLEAF_LOG_DIR/$name.log" 2>&1 </dev/null &
  echo $! >"$pid_file"
  echo "$name pid=$(cat "$pid_file")"
}

wait_port() {
  local name=$1
  local port=$2
  for _ in $(seq 1 120); do
    if port_open "$port"; then
      echo "$name is listening on 127.0.0.1:$port"
      return 0
    fi
    sleep 1
  done
  echo "$name did not open port $port; see $OVERLEAF_LOG_DIR/$name.log" >&2
  return 1
}

if [ ! -d "$ENROOT_DATA_PATH/overleaf-$OVERLEAF_VERSION" ]; then
  echo "Overleaf image is missing; run ./upgrade.sh first" >&2
  exit 1
fi

"$OVERLEAF_DIR/prepare-overleaf-rootfs.sh"

start_component mongo "mongo-8.0" "$OVERLEAF_CONFIG_DIR/mongo.conf"
wait_port mongo 27017

mongo_container_pid=$(container_pid "mongo-8.0")
enroot exec "$mongo_container_pid" \
  /usr/bin/mongosh --quiet --host 127.0.0.1 --eval '
    try {
      rs.conf();
    } catch (e) {
      rs.initiate({
        _id: "overleaf",
        members: [{ _id: 0, host: "127.0.0.1:27017" }],
      });
    }
  ' >/dev/null

for _ in $(seq 1 60); do
  if enroot exec "$mongo_container_pid" \
    /usr/bin/mongosh --quiet --host 127.0.0.1 --eval \
    'quit(db.hello().isWritablePrimary ? 0 : 1)' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

start_component redis "redis-6.2" "$OVERLEAF_CONFIG_DIR/redis.conf"
wait_port redis 6379

start_component overleaf "overleaf-$OVERLEAF_VERSION" \
  "$OVERLEAF_CONFIG_DIR/overleaf.conf"

for _ in $(seq 1 180); do
  if curl -fsS "http://127.0.0.1:$OVERLEAF_PORT/launchpad" >/dev/null 2>&1 ||
    curl -fsS "http://127.0.0.1:$OVERLEAF_PORT/login" >/dev/null 2>&1; then
    echo "Overleaf is available on http://127.0.0.1:$OVERLEAF_PORT"
    exit 0
  fi
  sleep 1
done

echo "Overleaf did not become ready; see $OVERLEAF_LOG_DIR/overleaf.log" >&2
tail -n 80 "$OVERLEAF_LOG_DIR/overleaf.log" >&2 || true
exit 1
