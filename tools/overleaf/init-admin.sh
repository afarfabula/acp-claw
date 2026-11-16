#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/enroot-env.sh"

credentials_file="$OVERLEAF_DATA_ROOT/admin-credentials.txt"
admin_email=${ADMIN_EMAIL:-$OVERLEAF_ADMIN_EMAIL}
admin_password=${ADMIN_PASSWORD:-}

if [ -z "$admin_password" ] && [ -f "$credentials_file" ]; then
  admin_password=$(awk -F= '$1 == "password" { print $2 }' "$credentials_file")
fi
if [ -z "$admin_password" ]; then
  admin_password=$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)
fi

headers=$(mktemp)
page_file=$(mktemp)
trap 'rm -f "$headers" "$page_file"' EXIT

curl -fsS \
  -D "$headers" \
  -o "$page_file" \
  -H 'Host: overleaf.afarfabula.org' \
  -H 'X-Forwarded-Proto: https' \
  "http://127.0.0.1:$OVERLEAF_PORT/launchpad"
page=$(cat "$page_file")

if printf '%s' "$page" | grep -q 'name="_csrf"'; then
  csrf=$(printf '%s' "$page" |
    grep -o 'name="_csrf" type="hidden" value="[^"]*"' |
    sed -E 's/.*value="([^"]*)".*/\1/' |
    head -n 1)
  session_cookie=$(grep -i '^set-cookie:' "$headers" |
    sed -E 's/^[Ss]et-[Cc]ookie: ([^;]+).*/\1/' |
    head -n 1)

  curl -fsS \
    -X POST "http://127.0.0.1:$OVERLEAF_PORT/launchpad/register_admin" \
    -H 'Host: overleaf.afarfabula.org' \
    -H 'Origin: https://overleaf.afarfabula.org' \
    -H 'Referer: https://overleaf.afarfabula.org/launchpad' \
    -H 'X-Forwarded-Proto: https' \
    -H "Cookie: $session_cookie" \
    --data-urlencode "_csrf=$csrf" \
    --data-urlencode "email=$admin_email" \
    --data-urlencode "password=$admin_password" \
    >/dev/null
else
  if curl -fsS "http://127.0.0.1:$OVERLEAF_PORT/launchpad" -o /dev/null; then
    echo "an admin account already exists"
    exit 0
  fi
  echo "launchpad did not expose the first-admin form" >&2
  exit 1
fi

umask 077
{
  echo "email=$admin_email"
  echo "password=$admin_password"
  echo "display_name=quyanyi"
} >"$credentials_file"

mongo_container_pid=$(enroot list -f |
  awk '$1 == "mongo-8.0" { print $2; exit }')
enroot exec "$mongo_container_pid" \
  /usr/bin/mongosh --quiet \
  'mongodb://127.0.0.1:27017/sharelatex?replicaSet=overleaf' \
  --eval "db.users.updateOne({email: '$admin_email'}, {\$set: {first_name: 'quyanyi'}})" \
  >/dev/null

echo "admin account created: $admin_email"
echo "credentials: $credentials_file"
