#!/usr/bin/env bash
# Daily entry point. Wrapped so cron and launchd get the same environment.
#
# Secrets live in ops/secrets.env (chmod 600, gitignored):
#   export WHOOP_CLIENT_ID=...
#   export WHOOP_CLIENT_SECRET=...
#   export INTERVALS_ICU_API_KEY=...
#   export SMTP_PASSWORD=...          # only if the Sunday summary sends itself

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

if [[ -f ops/secrets.env ]]; then
  # shellcheck disable=SC1091
  source ops/secrets.env
fi

PYTHON="${PYTHON:-$HERE/.venv/bin/python}"
if [[ ! -x "$PYTHON" ]]; then
  PYTHON="$(command -v python3)"
fi

mkdir -p state

# Wait for DNS before running.
#
# launchd fires a missed calendar interval the moment the Mac wakes, which is
# seconds before Wi-Fi associates. The engine then computed the day correctly
# and failed to write it anywhere:
#
#   intervals.icu write failed: Failed to resolve 'intervals.icu'
#   ([Errno 8] nodename nor servname provided, or not known)
#
# Every morning run was doing that. There is no "wait for network" option for
# StartCalendarInterval, so the wait belongs here.
wait_for_dns() {
  local host="$1" tries="$2" waited=0
  while [[ "$waited" -lt "$tries" ]]; do
    if "$PYTHON" -c 'import socket,sys; socket.getaddrinfo(sys.argv[1], 443)' "$host" \
         >/dev/null 2>&1; then
      [[ "$waited" -gt 0 ]] && echo "$(date '+%Y-%m-%d %H:%M:%S') network ready after $((waited * 5))s" >> state/cron.log
      return 0
    fi
    sleep 5
    waited=$((waited + 1))
  done
  return 1
}

if ! wait_for_dns intervals.icu 36; then
  # Three minutes without DNS: the run would only log two failures and a
  # misleading GREEN. Say so and stop, so the next firing gets a clean try.
  echo "$(date '+%Y-%m-%d %H:%M:%S') no DNS for intervals.icu after 180s; skipping this firing" \
    >> state/cron.log
  exit 0
fi

"$PYTHON" -m tenk.cli run "$@" >> state/cron.log 2>&1

# Sunday: the weekly summary goes to Slack through the Ernest Ops relay, on the
# last firing of the day only, so it is sent once.
#
# 10# forces base ten. Without it bash reads "08" and "09" as octal and the
# comparison fails outright, which would have skipped the two morning firings
# it guards.
LAST_FIRING_HOUR=10
HOUR=$((10#$(date +%H)))
if [[ "$(date +%u)" == "7" && "$HOUR" -ge "$LAST_FIRING_HOUR" && "${1:-}" != "--dry-run" ]]; then
  "$PYTHON" -m tenk.cli summary >> state/cron.log 2>&1 || true
fi
