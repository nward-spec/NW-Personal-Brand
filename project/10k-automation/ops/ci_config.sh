#!/usr/bin/env bash
# config/config.yaml is gitignored because it is per-machine. CI builds it from
# the committed example, changing only what differs on a runner.
set -euo pipefail

[ -n "${INTERVALS_ICU_ATHLETE_ID:-}" ] || {
  echo "ci_config: INTERVALS_ICU_ATHLETE_ID is not set" >&2; exit 1; }

python3 - "$INTERVALS_ICU_ATHLETE_ID" <<'PY'
import re, sys
from pathlib import Path

athlete = sys.argv[1]
text = Path("config/config.example.yaml").read_text()

text, n = re.subn(r'athlete_id: "i00000"', f'athlete_id: "{athlete}"', text, count=1)
assert n == 1, "athlete_id placeholder not found in config.example.yaml"

# No Google OAuth on a runner, and no synced folder to copy into: the dashboard
# reads the status file straight out of this repo instead.
text, n = re.subn(r'(google_calendar:\n(?:.*\n)*?  enabled: )\w+', r'\1false', text, count=1)
assert n == 1, "google_calendar.enabled not found"

Path("config/config.yaml").write_text(text)
print("ci_config: wrote config/config.yaml")
PY
