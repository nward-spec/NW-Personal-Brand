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
