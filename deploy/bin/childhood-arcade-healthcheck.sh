#!/bin/sh
set -eu

health_url="${CHILDHOOD_ARCADE_HEALTH_URL:-http://127.0.0.1:19097/api/health}"
attempt=1
max_attempts=3

while [ "$attempt" -le "$max_attempts" ]; do
  response=""
  if response="$(/usr/bin/curl --noproxy '*' --fail --silent --show-error \
      --connect-timeout 2 --max-time 5 "$health_url")" \
      && printf '%s' "$response" | /usr/bin/grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
    exit 0
  fi

  printf '%s\n' \
    "childhood-arcade health check failed (${attempt}/${max_attempts})" >&2

  if [ "$attempt" -lt "$max_attempts" ]; then
    /usr/bin/sleep 2
  fi
  attempt=$((attempt + 1))
done

# try-restart deliberately leaves an already-stopped service stopped. This
# monitor is allowed to recover only the Childhood Arcade application service.
/usr/bin/systemctl try-restart childhood-arcade.service || true
exit 1
