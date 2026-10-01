#!/usr/bin/env bash
# Install the morning schedule. Run it from anywhere:
#
#     ~/NW-Personal-Brand/project/10k-automation/ops/install_schedule.sh
#
# It fills the real project path into the template, VALIDATES the result,
# replaces any existing registration, and proves the job is loaded before it
# claims success. The validation step matters: launchd silently ignores a
# malformed plist under `launchctl load`, so a job can look installed for days
# and never run once.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

LABEL="com.nickward.tenk"
AGENTS="$HOME/Library/LaunchAgents"
TARGET="$AGENTS/$LABEL.plist"

echo "==> Project: $HERE"
mkdir -p "$AGENTS" state

if [[ ! -x .venv/bin/python ]]; then
  echo "No virtualenv yet. Run ops/setup.sh first." >&2
  exit 1
fi

echo "==> Writing $TARGET"
sed "s|__PROJECT__|$HERE|g" ops/com.nickward.tenk.plist.template > "$TARGET"

if grep -q "__PROJECT__" "$TARGET"; then
  echo "The project path was not substituted. Refusing to install." >&2
  exit 1
fi

echo "==> Validating"
if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$TARGET"
else
  echo "    (plutil not available; skipping lint)"
fi

echo "==> Registering"
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$TARGET"
launchctl enable "gui/$UID/$LABEL"

echo "==> Confirming it is loaded"
if launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
  launchctl print "gui/$UID/$LABEL" | grep -E "^\s+(state|path) " || true
  echo
  echo "Installed. It runs at 05:00, 05:30, 06:00, 06:30, 07:00, 07:30, 08:00,"
  echo "09:00 and 10:00 local time."
  echo
  echo "Tomorrow, check it actually fired:"
  echo "    tail -20 $HERE/state/cron.log"
else
  echo "The job did not register. Nothing is scheduled." >&2
  exit 1
fi
