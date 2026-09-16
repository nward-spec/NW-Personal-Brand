#!/usr/bin/env bash
# One-shot setup and verification.
#
# Finds its own directory, so it works whatever your shell is currently in and
# there is no cd to get wrong:
#
#     ~/NW-Personal-Brand/project/10k-automation/ops/setup.sh
#
# Creates the virtualenv if it is missing, installs the core dependencies
# (PyYAML and requests, pure-Python wheels everywhere, nothing compiled), then
# runs the test suite and the scenarios. Needs no credentials and writes
# nothing outside this folder.
#
# The Google Calendar libraries are deliberately NOT installed here. See
# requirements-calendar.txt.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

echo "==> Project: $HERE"

PYTHON="${PYTHON:-python3}"
if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "No '$PYTHON' on PATH. Install Python 3.9 or newer, or set PYTHON=/path/to/python3." >&2
  exit 1
fi

"$PYTHON" - <<'PYCHECK' || exit 1
import sys
if sys.version_info < (3, 9):
    sys.stderr.write(
        f"Python 3.9 or newer is needed; this is {sys.version.split()[0]}.\n"
    )
    raise SystemExit(1)
print(f"==> Interpreter: {sys.executable} ({sys.version.split()[0]})")
PYCHECK

if [[ ! -x .venv/bin/python ]]; then
  echo "==> Creating .venv"
  "$PYTHON" -m venv .venv
else
  echo "==> Reusing .venv"
fi

# Old pip ships with the system Python and mishandles some modern wheels.
# Worth upgrading, not worth failing over.
.venv/bin/python -m pip install --quiet --upgrade pip >/dev/null 2>&1 || \
  echo "    (could not upgrade pip inside the venv; carrying on)"

echo "==> Installing core dependencies"
.venv/bin/python -m pip install --quiet -r requirements.txt

echo "==> Running the test suite"
.venv/bin/python -m unittest discover -s tests -t .

echo "==> Running the scenarios against synthetic Whoop data"
.venv/bin/python -m tenk.cli selftest

cat <<'DONE'

==> Setup finished. Everything above passed.

Next, look at the block as it stands:

    .venv/bin/python -m tenk.cli show --week 7

To connect the accounts, copy config/config.example.yaml to config/config.yaml
and ops/secrets.env.example to ops/secrets.env, fill both in, then:

    .venv/bin/python -m tenk.cli authorize
    .venv/bin/python -m tenk.cli run --dry-run --window

The dry run prints every write and executes none.
DONE
