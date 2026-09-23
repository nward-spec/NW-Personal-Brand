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

# Sunday evening: the weekly summary goes to Slack through the Ernest Ops relay.
# Only on the last firing of the day, so it is sent once.
if [[ "$(date +%u)" == "7" && "$(date +%H)" -ge 11 && "${1:-}" != "--dry-run" ]]; then
  "$PYTHON" -m tenk.cli summary >> state/cron.log 2>&1 || true
fi
